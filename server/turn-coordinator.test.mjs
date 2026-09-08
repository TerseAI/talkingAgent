import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnCoordinator } from './turn-coordinator.mjs';

function setup(number = 1) {
  let holder = null;
  const getState = async () => ({ number, talkingStick: holder, count: number - 1, done: number > 100 });
  return new TurnCoordinator({
    getState,
    tryGetTalkingStick: async (id) => { holder = id; return { status: 'granted', next_number: number }; },
    doneSpeaking: async (id) => { assert.equal(id, holder); number++; holder = null; return { status: 'completed' }; },
    stop: async (id) => { if (holder === id) holder = null; return getState(); },
    reset: async () => { number = 1; holder = null; return getState(); },
  });
}

test('pending requests resolve directly in FIFO order after completion', async () => {
  const coordinator = setup();
  assert.equal((await coordinator.getTalkingStick('a')).next_number, 1);
  let bobDone = false;
  let charlieDone = false;
  const bob = coordinator.getTalkingStick('b').then((r) => { bobDone = true; return r; });
  const charlie = coordinator.getTalkingStick('c').then((r) => { charlieDone = true; return r; });
  await coordinator.operations;
  assert.equal(bobDone, false);
  await coordinator.doneSpeaking('a');
  assert.equal((await bob).next_number, 2);
  assert.equal(charlieDone, false);
  await coordinator.doneSpeaking('b');
  assert.equal((await charlie).next_number, 3);
});

test('aborted waiters are skipped and releasing does not advance', async () => {
  const coordinator = setup();
  await coordinator.getTalkingStick('a');
  const abort = new AbortController();
  const bob = coordinator.getTalkingStick('b', abort.signal);
  const charlie = coordinator.getTalkingStick('c');
  abort.abort();
  assert.equal((await bob).status, 'cancelled');
  await coordinator.cancel('a');
  assert.equal((await charlie).next_number, 1);
});

test('completion at 100 settles every waiter and reset cancels pending requests', async () => {
  const coordinator = setup(100);
  await coordinator.getTalkingStick('a');
  const bob = coordinator.getTalkingStick('b');
  await coordinator.doneSpeaking('a');
  assert.equal((await bob).status, 'done');
  await coordinator.reset();
  await coordinator.getTalkingStick('a');
  const pending = coordinator.getTalkingStick('b');
  await coordinator.reset();
  assert.equal((await pending).status, 'cancelled');
});

test('a holder can retrieve its grant again without waiting behind itself', async () => {
  const coordinator = setup();
  assert.deepEqual(await coordinator.getTalkingStick('a'), await coordinator.getTalkingStick('a'));
  assert.equal(coordinator.waiters.length, 0);
});

test('shutdown settles waiters and releases the holder without advancing', async () => {
  const coordinator = setup();
  await coordinator.getTalkingStick('a');
  const pending = coordinator.getTalkingStick('b');
  await coordinator.close();
  assert.equal((await pending).status, 'cancelled');
  assert.equal((await coordinator.getState()).number, 1);
  assert.equal((await coordinator.getState()).talkingStick, null);
});
