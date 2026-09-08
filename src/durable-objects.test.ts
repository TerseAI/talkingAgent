import { expect, test, vi } from 'vitest';
import { Counter } from './durable-objects';

const createCounter = (): Counter => {
  const counter = Reflect.construct(Counter, []);
  Object.defineProperty(counter, 'broadcast', { value: vi.fn() });
  return counter;
};

test('the DO persists only the number, holder, and waiting queue', () => {
  expect(Object.keys(createCounter()).sort()).toEqual(['number', 'talkingStick', 'waiting']);
});

test('one agent takes the stick; others wait until its spoken number finishes', async () => {
  const counter = createCounter();
  expect(await counter.getLatestCount('a')).toMatchObject({ status: 'granted', next_number: 1 });
  expect(counter.talkingStick).toBe('a');
  expect(await counter.getLatestCount('b')).toMatchObject({ status: 'waiting' });
  expect(counter.number).toBe(1);
  await expect(counter.doneSpeaking('b', 1)).rejects.toThrow();
  await expect(counter.doneSpeaking('a', 2)).rejects.toThrow();
  await counter.doneSpeaking('a', 1);
  expect(counter.number).toBe(2);
  expect(counter.talkingStick).toBe('b');
  expect(await counter.getLatestCount('b')).toMatchObject({ status: 'granted', next_number: 2 });
});

test('repeated claims and delayed completion retries do not steal or advance a turn', async () => {
  const counter = createCounter();
  expect(await counter.getLatestCount('a')).toEqual(await counter.getLatestCount('a'));
  await counter.doneSpeaking('a', 1);
  await counter.getLatestCount('b');
  await counter.doneSpeaking('a', 1);
  expect(counter.talkingStick).toBe('b');
  expect(counter.number).toBe(2);
  await counter.stop('a');
  expect(counter.talkingStick).toBe('b');
  await counter.stop('b');
  expect(counter.talkingStick).toBeNull();
  expect(counter.number).toBe(2);
});

test('serialized state resumes the same number and stops after 100', async () => {
  let counter = createCounter();
  for (let number = 1; number <= 100; number++) {
    const agent = `agent-${number % 3}`;
    expect(await counter.getLatestCount(agent)).toMatchObject({ next_number: number });
    counter = Object.assign(createCounter(), JSON.parse(JSON.stringify(counter)));
    await counter.doneSpeaking(agent, number);
  }
  expect(await counter.getLatestCount('a')).toMatchObject({ status: 'done', count: 100 });
  expect(counter.talkingStick).toBeNull();
  await counter.reset();
  expect(counter.number).toBe(1);
  expect(counter.talkingStick).toBeNull();
});

test('reserves FIFO turns and pulses only the selected agent', async () => {
  const counter = createCounter();
  const broadcast = (counter as unknown as { broadcast: ReturnType<typeof vi.fn> }).broadcast;
  await counter.getLatestCount('a');
  await counter.getLatestCount('b');
  await counter.getLatestCount('b');
  await counter.getLatestCount('c');
  expect(counter.waiting).toEqual(['b', 'c']);
  expect(broadcast).not.toHaveBeenCalled();
  await counter.doneSpeaking('a', 1);
  expect(counter.talkingStick).toBe('b');
  expect(broadcast).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'turn_available' }), { tags: ['b'] });
  expect(await counter.getLatestCount('a')).toEqual({ status: 'waiting' });
  expect(counter.talkingStick).toBe('b');
  await counter.doneSpeaking('a', 1);
  expect(broadcast).toHaveBeenCalledTimes(1);
  await counter.stop('b');
  expect(counter.talkingStick).toBe('c');
  expect(counter.number).toBe(2);
  expect(broadcast).toHaveBeenLastCalledWith(JSON.stringify({ type: 'turn_available' }), { tags: ['c'] });
  await counter.stop('a');
  expect(counter.waiting).toEqual([]);
  await counter.reset();
  expect(counter.talkingStick).toBeNull();
  expect(counter.waiting).toEqual([]);
});
