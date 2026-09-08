import { afterEach, expect, it, vi } from 'vitest';
import { NativeVoiceSession, type NativeDependencies } from './voice-session';
import { applyEvent, type Entry } from './transcript';

function fixture() {
  const track = { enabled: true, stop: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track], release: vi.fn() };
  const channel = { readyState: 'open', send: vi.fn(), close: vi.fn(), onmessage: null as null | ((event: unknown) => void), onclose: null, onerror: null };
  const peer = { createDataChannel: () => channel, addTrack: vi.fn(), close: vi.fn(), onconnectionstatechange: null, connectionState: 'new', createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'test-offer' }), setLocalDescription: vi.fn().mockResolvedValue(undefined), setRemoteDescription: vi.fn().mockResolvedValue(undefined) };
  const deps = { getMedia: vi.fn().mockResolvedValue(stream), createPeer: () => peer, startAudio: vi.fn(), stopAudio: vi.fn(), setSpeaker: vi.fn(), fetch: vi.fn().mockImplementation(async (url: string, _options: { body: string; headers: Record<string, string> }) => url.endsWith('/api/session') ? Response.json({ value: 'ek_ephemeral' }) : new Response('test-answer')) };
  const session = new NativeVoiceSession(deps as unknown as NativeDependencies);
  const event = (value: object) => channel.onmessage?.({ data: JSON.stringify(value) });
  return { session, deps, track, stream, peer, channel, event };
}
const options = { apiUrl: 'http://localhost:3000', instance: 1, mode: 'group-counting' as const };
afterEach(() => vi.useRealTimers());

it('runs three independent sessions without cross-talk in application state', async () => {
  const participants = [fixture(), fixture(), fixture()];
  await Promise.all(participants.map((item, index) => item.session.start({ ...options, instance: index + 1 })));
  participants.forEach((item) => item.event({ type: 'session.created' }));
  participants[0].event({ type: 'response.output_audio_transcript.done', item_id: 'a', transcript: 'One' });
  expect(participants[0].session.getSnapshot().transcript[0].text).toBe('One');
  expect(participants[1].session.getSnapshot().transcript).toEqual([]);
  expect(participants[2].session.getSnapshot().transcript).toEqual([]);
  participants[0].session.stop();
  expect(participants[0].track.stop).toHaveBeenCalledOnce();
  for (const item of participants.slice(1)) {
    expect(item.session.getSnapshot().status).toBe('connected');
    expect(item.track.stop).not.toHaveBeenCalled();
    item.session.stop();
  }
});

it('uses its own identity and ephemeral token, and waits for session confirmation', async () => {
  const { session, deps, track, event, peer } = fixture();
  await session.start({ ...options, instance: 3 });
  expect(session.getSnapshot().status).toBe('connecting');
  expect(track.enabled).toBe(false);
  expect(JSON.parse(deps.fetch.mock.calls[0][1].body)).toEqual({ instance: 3, mode: 'group-counting' });
  expect(deps.fetch.mock.calls[0][1].headers.Origin).toBe('http://localhost:3000');
  expect(deps.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer ek_ephemeral');
  expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'test-answer' });
  event({ type: 'session.created' });
  expect(session.getSnapshot().status).toBe('connected');
  expect(track.enabled).toBe(true);
  session.toggleMute();
  expect(track.enabled).toBe(false);
  session.stop();
  expect(deps.stopAudio).toHaveBeenCalledOnce();
});

it('stops a microphone acquired after cancellation without requesting a token', async () => {
  const { session, deps, stream, track } = fixture();
  let resolve!: (value: unknown) => void;
  deps.getMedia.mockReturnValue(new Promise((done) => { resolve = done; }));
  const start = session.start(options);
  session.stop();
  resolve(stream);
  await start;
  expect(track.stop).toHaveBeenCalledOnce();
  expect(stream.release).toHaveBeenCalledOnce();
  expect(deps.fetch).not.toHaveBeenCalled();
});

it('does not accept an SDP answer that arrives after cancellation', async () => {
  const { session, deps, peer, track } = fixture();
  let resolve!: (value: Response) => void;
  deps.fetch.mockResolvedValueOnce(Response.json({ value: 'ek_test' })).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const start = session.start(options);
  await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalledTimes(2));
  session.stop();
  resolve(new Response('late-answer'));
  await start;
  expect(peer.setRemoteDescription).not.toHaveBeenCalled();
  expect(peer.close).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalledOnce();
});

it('times out waiting for a confirmed session and closes native resources', async () => {
  vi.useFakeTimers();
  const { session, track, peer } = fixture();
  await session.start(options);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(session.getSnapshot().error).toMatch(/timed out/);
  expect(track.stop).toHaveBeenCalledOnce();
  expect(peer.close).toHaveBeenCalledOnce();
});

it('sends a message only to its own data channel, and can cancel generation', async () => {
  const { session, channel, event } = fixture();
  await session.start(options);
  event({ type: 'session.created' });
  expect(channel.send).not.toHaveBeenCalled(); // No automatic greeting or counting start.
  session.send('begin');
  expect(channel.send).toHaveBeenCalledTimes(2);
  expect(JSON.parse(channel.send.mock.calls[0][0]).item.content[0].text).toBe('begin');
  session.interrupt();
  expect(JSON.parse(channel.send.mock.calls[2][0]).type).toBe('response.cancel');
  session.stop();
});

it('reconciles transcript deltas without duplicating the completed text', () => {
  let entries: Entry[] = [];
  entries = applyEvent(entries, { type: 'response.output_audio_transcript.delta', item_id: 'a', delta: 'One' });
  entries = applyEvent(entries, { type: 'response.output_audio_transcript.done', item_id: 'a', transcript: 'One.' });
  entries = applyEvent(entries, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: 'Two' });
  expect(entries.map((entry) => entry.text)).toEqual(['One.', 'Two']);
  expect(entries.map((entry) => entry.role)).toEqual(['assistant', 'user']);
});
