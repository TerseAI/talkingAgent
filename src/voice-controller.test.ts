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
    transport: new EventEmitter(), connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(), mute: vi.fn(), interrupt: vi.fn(), sendMessage: vi.fn(),
  });
  const dependencies = {
    getMedia: vi.fn().mockResolvedValue(stream),
    createAudio: () => audio as unknown as HTMLAudioElement,
    getToken: vi.fn().mockResolvedValue('ek_test'),
    createSession: vi.fn().mockResolvedValue(session as unknown as RealtimeSession),
  };
  return { controller: new VoiceController(dependencies), dependencies, track, stream, session, audio };
}

afterEach(() => vi.useRealTimers());

describe('voice lifecycle', () => {
  it('connects with the ephemeral credential, supports controls, and releases the mic on stop', async () => {
    const { controller, session, track, audio } = setup();
    await controller.start();
    expect(session.connect).toHaveBeenCalledWith({ apiKey: 'ek_test' });
    expect(controller.getSnapshot().status).toBe('connected');
    expect(track.enabled).toBe(true);
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
