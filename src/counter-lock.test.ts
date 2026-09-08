import { expect, it, vi } from 'vitest';
import { CounterLock } from './counter-lock';

it('keeps a single HTTP request pending until the server grants the turn', async () => {
  let resolve!: (value: unknown) => void;
  const request = vi.fn(() => new Promise((yes) => { resolve = yes; }));
  const lock = new CounterLock('agent', new AbortController().signal, request as never);
  const first = lock.getTalkingStick();
  expect(lock.getTalkingStick()).toBe(first);
  expect(request).toHaveBeenCalledOnce();
  const completed = vi.fn();
  first.then(completed);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  resolve({ status: 'granted', next_number: 2 });
  expect(await first).toEqual({ status: 'granted', next_number: 2 });
  expect(request).toHaveBeenCalledOnce();
});

it('aborts the pending HTTP request when cancelled', async () => {
  const request = vi.fn((_action, _body, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  }));
  const lock = new CounterLock('agent', new AbortController().signal, request as never);
  const pending = lock.getTalkingStick();
  lock.cancel();
  expect(await pending).toEqual({ status: 'cancelled' });
  expect(request.mock.calls[0][2].aborted).toBe(true);
});
