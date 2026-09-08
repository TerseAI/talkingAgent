import { expect, it, vi } from 'vitest';
import { CountingConnection } from './counting-connection';

function setup() {
  const socket = Object.assign(new EventTarget(), { send: vi.fn(), close: vi.fn() });
  const openSocket = vi.fn(() => socket as unknown as WebSocket);
  const abort = new AbortController();
  const connection = new CountingConnection('agent', abort.signal, openSocket);
  const emitActorEvent = (data: object) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  const emitTurnChanged = (speakerId: string, requestId: string) => emitActorEvent({ type: 'turn_changed', turnRequestId: requestId,
    state: { nextNumber: 2, completedCount: 1, targetCount: 100, currentSpeakerId: speakerId, finished: false } });
  return { socket, openSocket, abort, connection, emitActorEvent, turn };
}

it('waits for its own broadcast and sends only one claim after actor readiness', async () => {
  const { connection, socket, openSocket, emitActorEvent, turn } = setup();
  const first = connection.waitForTurn();
  expect(connection.waitForTurn()).toBe(first);
  expect(openSocket).toHaveBeenCalledOnce();
  expect(socket.send).not.toHaveBeenCalled();
  emitActorEvent({ type: 'ready' });
  const requestId = JSON.parse(socket.send.mock.calls[0][0]).requestId;
  const completed = vi.fn();
  first.then(completed);
  emitTurnChanged('another-agent', requestId);
  emitTurnChanged('agent', crypto.randomUUID());
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  emitTurnChanged('agent', requestId);
  expect(await first).toEqual({ status: 'granted', completedCount: 1, numberToSpeak: 2, targetCount: 100 });
  expect(socket.send).toHaveBeenCalledOnce();
  const completion = connection.reportTurnComplete();
  expect(JSON.parse(socket.send.mock.calls[1][0])).toEqual({ type: 'report_turn_complete', requestId });
  emitActorEvent({ type: 'turn_completed', requestId });
  expect(await completion).toEqual({ status: 'completed' });
  connection.close();
});

it('closes the socket and cancels a waiting tool when the session ends', async () => {
  const { connection, socket, abort, emitActorEvent, turn } = setup();
  const pending = connection.waitForTurn();
  emitActorEvent({ type: 'ready' });
  const requestId = JSON.parse(socket.send.mock.calls[0][0]).requestId;
  abort.abort();
  emitTurnChanged('agent', requestId);
  expect(await pending).toEqual({ status: 'cancelled' });
  expect(socket.close).toHaveBeenCalledOnce();
});
