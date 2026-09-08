import { expect, it, vi } from 'vitest';
import { CounterLock } from './counter-lock';

function setup() {
  const connection = Object.assign(new EventTarget(), { close: vi.fn() });
  const abort = new AbortController();
  const request = vi.fn().mockResolvedValue({ status: 'waiting' });
  const lock = new CounterLock('agent', abort.signal, connection, request);
  return { connection, abort, request, lock };
}

it('waits for the socket, stays pending without polling, and returns the grant', async () => {
  const { connection, request, lock } = setup();
  const completed = vi.fn();
  const result = lock.claim().then(completed);
  expect(request).not.toHaveBeenCalled();
  connection.dispatchEvent(new Event('ready'));
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(completed).not.toHaveBeenCalled();
  request.mockResolvedValue({ status: 'granted', next_number: 2 });
  connection.dispatchEvent(new Event('turn'));
  await result;
  expect(completed).toHaveBeenCalledWith({ status: 'granted', next_number: 2 });
  expect(request).toHaveBeenCalledTimes(2);
});

it('does not lose a handoff arriving before the claim response', async () => {
  const { connection, request, lock } = setup();
  connection.dispatchEvent(new Event('ready'));
  request.mockImplementationOnce(async () => {
    connection.dispatchEvent(new Event('turn'));
    return { status: 'waiting' };
  }).mockResolvedValue({ status: 'granted', next_number: 3 });
  expect(await lock.claim()).toEqual({ status: 'granted', next_number: 3 });
});

it('cancels pending tools and closes the socket on session end', async () => {
  const { connection, abort, request, lock } = setup();
  connection.dispatchEvent(new Event('ready'));
  const result = lock.claim();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  abort.abort();
  expect(await result).toEqual({ status: 'cancelled' });
  expect(connection.close).toHaveBeenCalledOnce();
});

it('rechecks on reconnect and resolves done instead of leaving waiters hanging at 100', async () => {
  const { connection, request, lock } = setup();
  connection.dispatchEvent(new Event('ready'));
  const result = lock.claim();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  connection.dispatchEvent(new Event('error'));
  request.mockResolvedValue({ status: 'done', count: 100, target: 100 });
  connection.dispatchEvent(new Event('ready'));
  expect(await result).toEqual({ status: 'done', count: 100, target: 100 });
});

it('shares one pending wait across duplicate tool calls instead of cancelling the first', async () => {
  const { connection, request, lock } = setup();
  connection.dispatchEvent(new Event('ready'));
  const first = lock.claim();
  const second = lock.claim();
  expect(second).toBe(first);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  request.mockResolvedValue({ status: 'granted', next_number: 4 });
  connection.dispatchEvent(new Event('turn'));
  expect(await first).toEqual({ status: 'granted', next_number: 4 });
  expect(await second).toEqual({ status: 'granted', next_number: 4 });
  expect(request).toHaveBeenCalledTimes(2);
});
