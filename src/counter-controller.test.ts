import { afterEach, expect, test, vi } from 'vitest';
import { CounterController } from './counter-controller';
import { initialCounterState, type CounterSnapshot } from './counting-state';

const disposals: AbortController[] = [];
afterEach(() => { disposals.splice(0).forEach(abort => abort.abort()); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
function setup() {
  let state: CounterSnapshot = { ...initialCounterState(), runId: 1, revision: 1, status: 'running', participants: ['a', 'b'],
    turn: { runId: 1, turnId: 1, agentId: 'a', number: 1, deadline: Date.now() + 20000 } };
  const abort = new AbortController(); disposals.push(abort);
  const connection = Object.assign(new EventTarget(), { close: vi.fn() });
  const speech = deferred<void>();
  const driver = { speak: vi.fn((_turn, signal: AbortSignal) => Promise.race([speech.promise, new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))])), silence: vi.fn().mockResolvedValue(undefined), update: vi.fn() };
  const request = vi.fn(async (action: string) => {
    if (action === 'complete') state = { ...state, revision: state.revision + 1, count: 1, turn: { ...state.turn!, agentId: 'b', turnId: 2, number: 2 } };
    if (action === 'fail') state = { ...state, revision: state.revision + 1, status: 'paused', turn: null };
    return structuredClone({ ...state, result: 'committed' });
  });
  const controller = new CounterController('a', abort.signal, connection, driver, request as never, vi.fn());
  connection.dispatchEvent(new Event('ready'));
  return { controller, request, speech, driver, connection, setState: (next: CounterSnapshot) => { state = next; }, getState: () => state };
}

test('automatically acknowledges once after speech completes, despite repeated notifications', async () => {
  const { controller, driver, speech, request, connection } = setup();
  await controller.ready();
  connection.dispatchEvent(new Event('change')); connection.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(driver.speak).toHaveBeenCalledTimes(1));
  expect(request.mock.calls.filter(([action]) => action === 'complete')).toHaveLength(0);
  speech.resolve();
  await vi.waitFor(() => expect(request.mock.calls.filter(([action]) => action === 'complete')).toHaveLength(1));
  expect(controller.getSnapshot()?.count).toBe(1);
});

test('pause during playback aborts the operation without reporting completion or leaving', async () => {
  const { controller, driver, request, connection, getState, setState } = setup();
  await controller.ready();
  setState({ ...getState(), revision: 2, status: 'paused', turn: null });
  connection.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(driver.silence).toHaveBeenCalled());
  expect(request.mock.calls.some(([action]) => action === 'complete' || action === 'leave')).toBe(false);
  expect(controller.getSnapshot()?.participants).toEqual(['a', 'b']);
});

test('a missing ACK response is retried with the same turn without replaying speech', async () => {
  const { controller, request, speech, driver } = setup();
  await controller.ready();
  const implementation = request.getMockImplementation()!;
  let lost = true;
  request.mockImplementation(async action => {
    const result = await implementation(action);
    if (action === 'complete' && lost) { lost = false; throw new Error('lost response'); }
    return result;
  });
  speech.resolve();
  await vi.waitFor(() => expect(request.mock.calls.filter(([action]) => action === 'complete')).toHaveLength(2));
  expect(driver.speak).toHaveBeenCalledTimes(1);
});

test('does not acknowledge a quiet barrier until audio has stopped', async () => {
  const { controller, driver, getState, setState, connection, request } = setup();
  await controller.ready();
  const quiet = deferred<void>(); driver.silence.mockReturnValue(quiet.promise);
  setState({ ...getState(), revision: 2, status: 'paused', turn: null, barrier: { id: 2, waitingFor: ['a'], next: 'talk', deadline: Date.now() + 10000 } });
  connection.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(driver.silence).toHaveBeenCalled());
  expect(request.mock.calls.some(call => (call as unknown as [string, { quietBarrier?: number }])[1]?.quietBarrier === 2)).toBe(false);
  quiet.resolve();
  await vi.waitFor(() => expect(request.mock.calls.some(call => (call as unknown as [string, { quietBarrier?: number }])[1]?.quietBarrier === 2)).toBe(true));
});

test('times out a stalled speaker, silences it, and pauses the run', async () => {
  vi.useFakeTimers();
  const { controller, request, driver } = setup();
  await controller.ready();
  await vi.advanceTimersByTimeAsync(15001);
  expect(driver.silence).toHaveBeenCalled();
  expect(request.mock.calls.some(([action]) => action === 'fail')).toBe(true);
  expect(request.mock.calls.some(([action]) => action === 'complete')).toBe(false);
  expect(controller.getSnapshot()?.status).toBe('paused');
});
