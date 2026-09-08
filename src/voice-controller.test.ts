import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeItem, RealtimeSession } from '@openai/agents/realtime';
import { VoiceController, toTranscript } from './voice-controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const track = Object.assign(new EventTarget(), { enabled: true, stop: vi.fn() });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const audio = Object.assign(new EventTarget(), { play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), srcObject: null });
  const session = Object.assign(new EventEmitter(), {
    transport: Object.assign(new EventEmitter(), { sendEvent: vi.fn() }), connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(), mute: vi.fn(), interrupt: vi.fn(), sendMessage: vi.fn(),
  });
  const dependencies = {
    getMedia: vi.fn().mockResolvedValue(stream),
    createAudio: () => audio as unknown as HTMLAudioElement,
    getToken: vi.fn().mockResolvedValue('ek_test'),
    createCountingConnection: vi.fn(() => ({ close: vi.fn(), connect: vi.fn(), completeTurn: vi.fn(), pauseCount: vi.fn().mockResolvedValue({ status: 'ok' }), onStateChanged: null }) as unknown as import('./counting-connection').CountingConnection),
    createSession: vi.fn().mockResolvedValue(session as unknown as RealtimeSession),
  };
  return { controller: new VoiceController(dependencies), dependencies, track, stream, session, audio };
}

afterEach(() => vi.useRealTimers());

describe('voice lifecycle', () => {
  it('connects with the ephemeral credential, supports controls, and releases the mic on stop', async () => {
    const { controller, dependencies, session, track, audio } = setup();
    await controller.start('cedar');
    expect(dependencies.createSession.mock.calls[0][5]).toBe('cedar');
    expect(session.connect).toHaveBeenCalledWith({ apiKey: 'ek_test' });
    expect(controller.getSnapshot().status).toBe('connected');
    expect(track.enabled).toBe(true);
    expect(session.transport.sendEvent).not.toHaveBeenCalled();
    expect(session.sendMessage).not.toHaveBeenCalled();
    session.emit('transport_event', { type: 'output_audio_buffer.stopped' });
    expect(session.transport.sendEvent).not.toHaveBeenCalled();
    controller.toggleMute();
    expect(session.mute).toHaveBeenCalledWith(true);
    controller.send('  hello  ');
    expect(session.sendMessage).toHaveBeenCalledWith('hello');
    controller.interrupt();
    expect(session.interrupt).toHaveBeenCalledOnce();
    controller.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().status).toBe('ended');
  });

  it('does not create a session if cancelled while the permission prompt is open', async () => {
    const { controller, dependencies, stream, track } = setup();
    const permission = deferred<MediaStream>();
    dependencies.getMedia.mockReturnValue(permission.promise);
    const attempt = controller.start();
    controller.stop();
    permission.resolve(stream);
    await attempt;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(dependencies.getToken).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBe('ended');
  });

  it('aborts a token request and ignores its late result after cancellation', async () => {
    const { controller, dependencies, track } = setup();
    const token = deferred<string>();
    dependencies.getToken.mockReturnValue(token.promise);
    const attempt = controller.start();
    await vi.waitFor(() => expect(dependencies.getToken).toHaveBeenCalledOnce());
    const signal = dependencies.getToken.mock.calls[0][0] as AbortSignal;
    expect(track.enabled).toBe(false);
    controller.stop();
    expect(signal.aborted).toBe(true);
    token.resolve('ek_late');
    await attempt;
    expect(dependencies.createSession).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it('cannot be resurrected by a connect that resolves after stop', async () => {
    const { controller, session, track } = setup();
    const connection = deferred<void>();
    session.connect.mockReturnValue(connection.promise);
    const attempt = controller.start();
    await vi.waitFor(() => expect(session.connect).toHaveBeenCalledOnce());
    controller.stop();
    connection.resolve();
    await attempt;
    expect(controller.getSnapshot().status).toBe('ended');
    expect(track.enabled).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it('ignores duplicate starts and cleans up after unexpected disconnection', async () => {
    const { controller, dependencies, session, track } = setup();
    await Promise.all([controller.start(), controller.start()]);
    expect(dependencies.getMedia).toHaveBeenCalledOnce();
    session.transport.emit('connection_change', 'disconnected');
    expect(controller.getSnapshot().status).toBe('error');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('reports denied permissions without requesting a credential', async () => {
    const { controller, dependencies } = setup();
    dependencies.getMedia.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    await controller.start();
    expect(controller.getSnapshot().error).toMatch(/Microphone access was denied/);
    expect(dependencies.getToken).not.toHaveBeenCalled();
  });

  it('ends a stalled connection and stops a subsequently acquired microphone', async () => {
    vi.useFakeTimers();
    const { controller, dependencies, stream, track } = setup();
    const permission = deferred<MediaStream>();
    dependencies.getMedia.mockReturnValue(permission.promise);
    const attempt = controller.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(controller.getSnapshot().error).toMatch(/timed out/);
    permission.resolve(stream);
    await attempt;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(dependencies.getToken).not.toHaveBeenCalled();
  });

  it('offers playback recovery and preserves the transcript on failure', async () => {
    const { controller, session, audio } = setup();
    await controller.start();
    audio.play.mockRejectedValueOnce(new DOMException('Autoplay blocked', 'NotAllowedError'));
    audio.dispatchEvent(new Event('canplay'));
    await vi.waitFor(() => expect(controller.getSnapshot().playbackBlocked).toBe(true));
    await controller.enablePlayback();
    expect(controller.getSnapshot().playbackBlocked).toBe(false);
    session.emit('history_updated', [{ type: 'message', itemId: '1', role: 'user', status: 'completed', content: [{ type: 'input_text', text: 'Hello' }] }]);
    session.emit('error', { error: new Error('upstream') });
    expect(controller.getSnapshot().transcript[0].text).toBe('Hello');
    expect(controller.getSnapshot().status).toBe('error');
  });
});

it('combines audio/text transcripts, skips tools, and preserves interrupted turns', () => {
  const history: RealtimeItem[] = [
    { type: 'message', itemId: '1', role: 'user', status: 'completed', content: [{ type: 'input_audio', transcript: 'Hello' }] },
    { type: 'message', itemId: '2', role: 'assistant', status: 'incomplete', content: [{ type: 'output_audio', transcript: 'Hi there' }] },
    { type: 'function_call', itemId: '3', status: 'completed', name: 'tool', arguments: '{}', output: 'ok' },
  ];
  expect(toTranscript(history)).toEqual([
    { id: '1', role: 'user', text: 'Hello', status: 'completed' },
    { id: '2', role: 'assistant', text: 'Hi there', status: 'incomplete' },
  ]);
});

it('joins the room once connected and stays in it through speech, typing, and interruptions', async () => {
  const { controller, dependencies, session } = setup();
  await controller.start();
  const countingConnection = dependencies.createCountingConnection.mock.results[0].value;
  expect(countingConnection.connect).toHaveBeenCalledOnce();
  session.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
  controller.send('How are you?');
  controller.interrupt();
  expect(countingConnection.close).not.toHaveBeenCalled();
  controller.stop();
  expect(countingConnection.close).toHaveBeenCalledOnce();
});

it('cues its number into the live session, completes the turn after playback, and closes the mic for others', async () => {
  const { controller, dependencies, session } = setup();
  await controller.start('cedar');
  const countingConnection = dependencies.createCountingConnection.mock.results[0].value;
  const me = dependencies.createSession.mock.calls[0][2] as string;
  const state = { nextNumber: 5, completedCount: 4, targetCount: 100, currentSpeakerId: 'someone-else', counting: true, finished: false };
  countingConnection.onStateChanged!(state, 'turn-a');
  expect(session.mute).toHaveBeenLastCalledWith(true);
  expect(controller.getSnapshot().micGated).toBe(true);
  expect(session.transport.sendEvent).not.toHaveBeenCalled();
  countingConnection.onStateChanged!({ ...state, currentSpeakerId: me }, 'turn-b');
  expect(session.mute).toHaveBeenLastCalledWith(false);
  expect(session.transport.sendEvent).toHaveBeenCalledWith({ type: 'response.create', response: { instructions: expect.stringMatching(/number 5/), metadata: { turnId: 'turn-b' } } });
  session.emit('transport_event', { type: 'response.created', response: { id: 'resp_5', metadata: { turnId: 'turn-b' } } });
  session.emit('transport_event', { type: 'response.done', response: { id: 'resp_5', status: 'completed', output: [{ type: 'message' }] } });
  session.emit('transport_event', { type: 'output_audio_buffer.stopped', response_id: 'resp_5' });
  expect(countingConnection.completeTurn).toHaveBeenCalledWith('turn-b');
  countingConnection.onStateChanged!({ ...state, nextNumber: 8, currentSpeakerId: me }, 'turn-c');
  session.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
  expect(countingConnection.pauseCount).toHaveBeenCalledOnce();
  controller.toggleMute();
  countingConnection.onStateChanged!({ ...state, counting: false, currentSpeakerId: null }, null);
  expect(session.mute).toHaveBeenLastCalledWith(true);
  controller.stop();
});

describe('diagnostic timeline', () => {
  it('keeps generated, pending, returned and playback events in arrival order across history updates', async () => {
    const { controller, session } = setup();
    await controller.start();
    const details = { toolCall: { type: 'function_call', callId: 'call_1', name: 'wait_for_turn', arguments: '{}' } };
    session.emit('transport_event', { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_1', name: 'wait_for_turn' } });
    session.emit('transport_event', { type: 'response.function_call_arguments.done', call_id: 'call_1', arguments: '{}' });
    session.emit('agent_tool_start', {}, {}, { name: 'wait_for_turn' }, details);
    expect(controller.getSnapshot().transcript[1].status).toBe('in_progress');
    const message = { type: 'message', itemId: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '1' }] };
    session.emit('agent_tool_end', {}, {}, { name: 'wait_for_turn' }, '{"numberToSpeak":1}', details);
    session.emit('history_updated', [message]);
    session.emit('transport_event', { type: 'output_audio_buffer.started', response_id: 'response_1' });
    session.emit('history_updated', [message]);
    const entries = controller.getSnapshot().transcript;
    expect(entries.map((entry) => entry.role)).toEqual(['tool', 'tool', 'tool', 'assistant', 'event']);
    expect(entries.slice(0, 3).map((entry) => entry.callId)).toEqual(['call_1', 'call_1', 'call_1']);
    expect(entries[0].text).toBe('{}');
    expect(entries[1].status).toBe('completed');
    expect(entries[2].text).toBe('{"numberToSpeak":1}');
    expect(entries[4].title).toContain('output_audio_buffer.started');
    controller.stop();
  });

  it('labels an unresolved tool on disconnect without inventing a result', async () => {
    const { controller, session } = setup();
    await controller.start();
    session.emit('agent_tool_start', {}, {}, { name: 'wait_for_turn' }, { toolCall: { callId: 'pending', arguments: '{}' } });
    controller.stop();
    expect(controller.getSnapshot().transcript).toHaveLength(1);
    expect(controller.getSnapshot().transcript[0].status).toBe('incomplete');
  });
});
