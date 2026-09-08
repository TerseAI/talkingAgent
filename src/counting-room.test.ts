import { expect, test, vi } from 'vitest';
import type { ActorSocket } from 'little-durable-objects';
import { CountingRoom, type Participant } from './counting-room';

function setup(saved?: object, sockets = new Map<string, ActorSocket<Participant>>()) {
  const room = Object.assign(Reflect.construct(CountingRoom, []) as CountingRoom, saved);
  const broadcast = vi.fn();
  Object.defineProperty(room, 'connections', { get: () => [...sockets.values()] });
  Object.defineProperty(room, 'broadcast', { value: broadcast });
  const join = (participantId: string) => {
    const socket: ActorSocket<Participant> = {
      id: participantId, metadata: { participantId, socketId: participantId, turnRequestId: null, waitingOrder: null },
      state: 'open', tags: [], send: vi.fn(), close: vi.fn(), reject: vi.fn(), setTags: vi.fn(),
    };
    sockets.set(participantId, socket);
    return socket;
  };
  const send = async (participantId: string, type: string, requestId = crypto.randomUUID()) => {
    const socket = sockets.get(participantId) ?? join(participantId);
    await room.onMessage(socket, JSON.stringify({ type, requestId }));
    return requestId;
  };
  const requestTurn = (participantId: string) => send(participantId, 'request_turn');
  const reportComplete = (participantId: string, requestId = room.currentSpeaker?.turnRequestId ?? crypto.randomUUID()) => send(participantId, 'report_turn_complete', requestId);
  const resetCount = () => send('a', 'reset_count');
  const disconnect = async (participantId: string) => {
    const socket = sockets.get(participantId)!;
    sockets.delete(participantId);
    await room.onDisconnect(socket);
  };
  const lastBroadcast = () => JSON.parse(broadcast.mock.calls.at(-1)![0]);
  return { room, sockets, requestTurn, reportComplete, resetCount, disconnect, lastBroadcast };
}

test('stores only nextNumber and currentSpeaker while connection metadata preserves waiting order', async () => {
  const { room, sockets, requestTurn } = setup();
  await requestTurn('a');
  const bobRequest = await requestTurn('b');
  await requestTurn('c');
  expect(Object.keys(room).sort()).toEqual(['currentSpeaker', 'nextNumber']);
  const restored = setup(JSON.parse(JSON.stringify(room)), sockets);
  await restored.reportComplete('a');
  expect(restored.lastBroadcast()).toMatchObject({ type: 'turn_changed', turnRequestId: bobRequest,
    state: { currentSpeakerId: 'b', nextNumber: 2 } });
  expect(sockets.get('b')!.metadata.waitingOrder).toBeNull();
  expect(sockets.get('c')!.metadata.waitingOrder).not.toBeNull();
});

test('only the current currentSpeaker and grant can reportComplete, then the next turn is broadcast', async () => {
  const { room, sockets, requestTurn, reportComplete, lastBroadcast } = setup();
  const aliceRequest = await requestTurn('a');
  const bobRequest = await requestTurn('b');
  await reportComplete('b', bobRequest);
  expect(sockets.get('b')!.send).toHaveBeenLastCalledWith(expect.stringContaining('This turn is not assigned to you'));
  expect(room.nextNumber).toBe(1);
  await reportComplete('a', aliceRequest);
  expect(sockets.get('a')!.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'turn_completed', requestId: aliceRequest }));
  expect(lastBroadcast()).toMatchObject({ type: 'turn_changed', turnRequestId: bobRequest,
    state: { nextNumber: 2, completedCount: 1, currentSpeakerId: 'b' } });
  await reportComplete('a', aliceRequest);
  expect(room.nextNumber).toBe(2);
});

test('disconnect excludes waiting connections and reassigns an unfinished number', async () => {
  const { room, requestTurn, disconnect, lastBroadcast } = setup();
  await requestTurn('a');
  await requestTurn('b');
  await requestTurn('c');
  await disconnect('b');
  expect((await room.getSnapshot()).currentSpeakerId).toBe('a');
  await disconnect('a');
  expect(lastBroadcast()).toMatchObject({ type: 'turn_changed', state: { currentSpeakerId: 'c', nextNumber: 1 } });
});

test('completion at 100 broadcasts finished, and reset clears pending connection metadata', async () => {
  const { room, sockets, requestTurn, reportComplete, resetCount, lastBroadcast } = setup({ nextNumber: 100 });
  await requestTurn('a');
  await requestTurn('b');
  await reportComplete('a');
  expect(lastBroadcast()).toMatchObject({ type: 'turn_changed', turnRequestId: null, state: { finished: true, completedCount: 100 } });
  await resetCount();
  await requestTurn('a');
  await requestTurn('b');
  await resetCount();
  expect(lastBroadcast()).toMatchObject({ type: 'count_reset', state: { nextNumber: 1, currentSpeakerId: null } });
  expect([...sockets.values()].every(({ metadata }) => metadata.waitingOrder === null && metadata.turnRequestId === null)).toBe(true);
  expect(room.currentSpeaker).toBeNull();
});
