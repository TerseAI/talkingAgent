import { expect, it, vi } from 'vitest';
import { CountingConnection } from './counting-connection';
const TURN = crypto.randomUUID();

function setup() {
  const sockets: (EventTarget & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> })[] = [];
  const openSocket = vi.fn(() => {
    const socket = Object.assign(new EventTarget(), { send: vi.fn(), close: vi.fn() });
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const abort = new AbortController();
  const connection = new CountingConnection('agent', abort.signal, openSocket);
  const emit = (data: object, socket = sockets.at(-1)!) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  const state = { nextNumber: 2, completedCount: 1, targetCount: 100, currentSpeakerId: 'agent', counting: true, finished: false };
  return { sockets, openSocket, abort, connection, emit, state };
}

it('sends commands after readiness, resolves them by acknowledgment, and relays state broadcasts', async () => {
  const { connection, sockets, openSocket, emit, state } = setup();
  const onState = vi.fn();
  connection.onStateChanged = onState;
  const started = connection.startCount();
  const paused = connection.pauseCount();
  expect(openSocket).toHaveBeenCalledOnce();
  expect(sockets[0].send).not.toHaveBeenCalled();
  emit({ type: 'ready' });
  const [startCommand, pauseCommand] = sockets[0].send.mock.calls.map(([raw]) => JSON.parse(raw));
  expect(startCommand.type).toBe('start_count');
  expect(pauseCommand.type).toBe('pause_count');
  emit({ type: 'ack', requestId: pauseCommand.requestId });
  expect(await paused).toEqual({ status: 'ok' });
  emit({ type: 'state_changed', state, turnId: TURN });
  expect(onState).toHaveBeenCalledWith(state, TURN);
  emit({ type: 'ack', requestId: startCommand.requestId });
  expect(await started).toEqual({ status: 'ok' });
  connection.completeTurn(TURN);
  expect(JSON.parse(sockets[0].send.mock.calls[2][0])).toEqual({ type: 'complete_turn', turnId: TURN });
});

it('rejoins the room after an unexpected close while the session is alive, and stops on abort', async () => {
  vi.useFakeTimers();
  try {
    const { connection, sockets, openSocket, abort, emit } = setup();
    connection.onStateChanged = vi.fn();
    connection.connect();
    emit({ type: 'ready' });
    sockets[0].dispatchEvent(Object.assign(new Event('close'), { code: 1011, reason: 'gone', wasClean: false }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(openSocket).toHaveBeenCalledTimes(2);
    const pending = connection.startCount();
    abort.abort();
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(sockets[1].close).toHaveBeenCalledOnce();
    sockets[1].dispatchEvent(Object.assign(new Event('close'), { code: 1005, reason: '', wasClean: true }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(openSocket).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it('rejects pending commands on a room error', async () => {
  const { connection, emit } = setup();
  const pending = connection.resetCount();
  emit({ type: 'ready' });
  emit({ type: 'error', message: 'Invalid counting command.' });
  await expect(pending).rejects.toThrow('Invalid counting command.');
});
