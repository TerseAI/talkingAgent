import { expect, test, vi } from 'vitest';
import type { ActorSocket } from 'little-durable-objects';
import { CountingRoom, type Participant } from './counting-room';

function setup(saved?: object, sockets = new Map<string, ActorSocket<Participant>>()) {
  const room = Object.assign(Reflect.construct(CountingRoom, []) as CountingRoom, saved);
  const broadcast = vi.fn();
  Object.defineProperty(room, 'connections', { get: () => [...sockets.values()] });
  Object.defineProperty(room, 'broadcast', { value: broadcast });
  const ids: Record<string, string> = {};
  const pid = (name: string) => ids[name] ??= crypto.randomUUID();
  const join = async (name: string) => {
    const socket = {
      id: name, metadata: { participantId: pid(name) } as unknown as Participant,
      state: 'open', tags: [], send: vi.fn(), close: vi.fn(), reject: vi.fn(), setTags: vi.fn(),
    } as ActorSocket<Participant>;
    sockets.set(name, socket);
    await room.onConnect(socket);
    return socket;
  };
  const send = async (participantId: string, command: object) => {
    const socket = sockets.get(participantId) ?? await join(participantId);
    await room.onMessage(socket, JSON.stringify(command));
    return socket;
  };
  const start = (participantId: string, requestId = crypto.randomUUID()) => send(participantId, { type: 'start_count', requestId });
  const pause = (participantId: string, requestId = crypto.randomUUID()) => send(participantId, { type: 'pause_count', requestId });
  const reset = (participantId: string, requestId = crypto.randomUUID()) => send(participantId, { type: 'reset_count', requestId });
  const complete = (participantId: string, turnId = room.currentSpeaker?.turnId ?? crypto.randomUUID()) => send(participantId, { type: 'complete_turn', turnId });
  const expire = (participantId: string, turnId = room.currentSpeaker?.turnId ?? crypto.randomUUID()) => send(participantId, { type: 'expire_turn', turnId });
  const disconnect = async (participantId: string) => {
    const socket = sockets.get(participantId)!;
    sockets.delete(participantId);
    await room.onDisconnect(socket);
  };
  const lastBroadcast = () => JSON.parse(broadcast.mock.calls.at(-1)![0]);
  return { room, sockets, pid, join, start, pause, reset, complete, expire, disconnect, lastBroadcast };
}

test('rotates turns round-robin from the participant who started, and saves only count, flag, speaker, join counter, and pause position', async () => {
  const { room, pid, join, start, complete, lastBroadcast } = setup();
  await join('a'); await join('b'); await join('c');
  const requestId = crypto.randomUUID();
  const starter = await start('b', requestId);
  expect(starter.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'ack', requestId }));
  expect(lastBroadcast()).toMatchObject({ type: 'state_changed', turnId: room.currentSpeaker!.turnId, state: { counting: true, currentSpeakerId: pid('b'), nextNumber: 1 } });
  expect(Object.keys(room).sort()).toEqual(['counting', 'currentSpeaker', 'joined', 'nextNumber', 'pausedAt']);
  await complete('b');
  expect(room.currentSpeaker?.participantId).toBe(pid('c'));
  await complete('c');
  expect(room.currentSpeaker?.participantId).toBe(pid('a'));
  await complete('a');
  expect(lastBroadcast()).toMatchObject({ state: { currentSpeakerId: pid('b'), nextNumber: 4, completedCount: 3 } });
});

test('only the assigned socket and turn id can end a turn, once', async () => {
  const { room, pid, join, start, complete, expire } = setup();
  await join('a'); await join('b');
  await start('a');
  const turnId = room.currentSpeaker!.turnId;
  await complete('b', turnId);
  await complete('a', crypto.randomUUID());
  await expire('b', turnId);
  expect(room.nextNumber).toBe(1);
  await expire('a', turnId);
  expect(room.nextNumber).toBe(2);
  expect(room.currentSpeaker?.participantId).toBe(pid('b'));
  await complete('a', turnId);
  expect(room.nextNumber).toBe(2);
});

test('disconnect hands an unfinished number to the next participant; a late joiner takes an empty turn', async () => {
  const { room, pid, join, start, complete, disconnect, lastBroadcast } = setup();
  await join('a'); await join('b');
  await start('a');
  await disconnect('a');
  expect(lastBroadcast()).toMatchObject({ state: { currentSpeakerId: pid('b'), nextNumber: 1, counting: true } });
  await complete('b');
  expect(room.currentSpeaker?.participantId).toBe(pid('b'));
  await disconnect('b');
  expect(room.currentSpeaker).toBeNull();
  expect(room.counting).toBe(true);
  await join('c');
  expect(lastBroadcast()).toMatchObject({ state: { currentSpeakerId: pid('c'), nextNumber: 2 } });
});

test('pause keeps the count and resumes with the interrupted speaker, and 100 finishes', async () => {
  const { room, pid, join, start, pause, complete, lastBroadcast } = setup({ nextNumber: 98 });
  await join('a'); await join('b'); await join('c');
  await start('a');
  await complete('a');
  expect(room.currentSpeaker?.participantId).toBe(pid('b'));
  await pause('c');
  expect(lastBroadcast()).toMatchObject({ turnId: null, state: { counting: false, currentSpeakerId: null, nextNumber: 99 } });
  await start('c');
  expect(room.currentSpeaker?.participantId).toBe(pid('b'));
  await complete('b');
  expect(room.currentSpeaker?.participantId).toBe(pid('c'));
  await pause('a');
  await start('a');
  expect(room.currentSpeaker?.participantId).toBe(pid('c'));
  await complete('c');
  await complete('b');
  expect(lastBroadcast()).toMatchObject({ turnId: null, state: { finished: true, counting: false, completedCount: 100 } });
  await start('a');
  expect(room.counting).toBe(false);
});

test('a pause with nobody assigned resumes with the requester, and works on a snapshot lacking newer fields', async () => {
  const { room, pid, join, start, pause } = setup({ nextNumber: 5, counting: false, currentSpeaker: null });
  Reflect.deleteProperty(room, 'joined');
  Reflect.deleteProperty(room, 'pausedAt');
  await join('a'); await join('b');
  await pause('a');
  await start('b');
  expect(room.currentSpeaker?.participantId).toBe(pid('b'));
  expect(room.joined).toBe(2);
});

test('reset returns to one with counting stopped, and survives a restore from saved fields', async () => {
  const { room, pid, sockets, join, start, reset, lastBroadcast } = setup();
  await join('a'); await join('b');
  await start('a');
  await reset('b');
  expect(lastBroadcast()).toMatchObject({ state: { nextNumber: 1, counting: false, currentSpeakerId: null } });
  await start('a');
  const restored = setup(JSON.parse(JSON.stringify(room)), sockets);
  await restored.complete('a');
  expect(restored.lastBroadcast()).toMatchObject({ state: { currentSpeakerId: pid('b'), nextNumber: 2 } });
});

test('rejects invalid identities and malformed commands', async () => {
  const { room, join } = setup();
  const bad = { id: 'x', metadata: { participantId: 'not valid' }, state: 'open', tags: [], send: vi.fn(), close: vi.fn(), reject: vi.fn(), setTags: vi.fn() };
  await room.onConnect(bad as unknown as ActorSocket<Participant>);
  expect(bad.reject).toHaveBeenCalledWith(4000, 'Invalid participant identity.');
  const socket = await join('a');
  await room.onMessage(socket, '{"type":"complete_turn"}');
  expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'error', message: 'Invalid counting command.' }));
});
