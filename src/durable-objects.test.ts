import { expect, test } from 'vitest';
import { Counter } from './durable-objects';
const createCounter = (): Counter => Reflect.construct(Counter, []);

test('persists only the number and holder', () => {
  expect(Object.keys(createCounter()).sort()).toEqual(['number', 'talkingStick']);
});

test('only the holder can complete the reserved number', async () => {
  const counter = createCounter();
  expect(await counter.tryGetTalkingStick('a')).toMatchObject({ next_number: 1 });
  expect(await counter.tryGetTalkingStick('b')).toEqual({ status: 'waiting' });
  await expect(counter.doneSpeaking('b')).rejects.toThrow();
  expect(await counter.doneSpeaking('a')).toEqual({ status: 'completed' });
  expect(counter.number).toBe(2);
  expect(counter.talkingStick).toBeNull();
  await expect(counter.doneSpeaking('a')).rejects.toThrow();
  expect(counter.number).toBe(2);
});

test('release does not advance and a non-holder cannot release another agent', async () => {
  const counter = createCounter();
  await counter.tryGetTalkingStick('a');
  await counter.stop('b');
  expect(counter.talkingStick).toBe('a');
  await counter.stop('a');
  expect(counter.talkingStick).toBeNull();
  expect(counter.number).toBe(1);
});

test('serialized state resumes and stops at 100', async () => {
  let counter = createCounter();
  for (let number = 1; number <= 100; number++) {
    expect(await counter.tryGetTalkingStick('a')).toMatchObject({ next_number: number });
    counter = Object.assign(createCounter(), JSON.parse(JSON.stringify(counter)));
    await counter.doneSpeaking('a');
  }
  expect(await counter.tryGetTalkingStick('b')).toMatchObject({ status: 'done', count: 100 });
  await counter.reset();
  expect(counter.number).toBe(1);
});
