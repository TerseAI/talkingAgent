import { afterEach, expect, test, vi } from 'vitest';
import { CountingCoordinator, isExpectedNumber } from './counting-coordinator';
import type { counterRequest } from './counter-api';

afterEach(() => vi.useRealTimers());

async function setup({ playback = true, number = 1 } = {}) {
  vi.useFakeTimers();
  const request = vi.fn(async (action = '') => {
    if (action === 'claim') return { status: 'granted', latest_count: number - 1, next_number: number, target: 100 };
    if (action === 'complete') return { count: number, done: number === 100 };
    return { ok: true };
  });
  const requestResponse = vi.fn();
  const onError = vi.fn();
  const onDone = vi.fn();
  const setOutputEnabled = vi.fn();
  const coordinator = new CountingCoordinator({ request: request as typeof counterRequest, requestResponse, setOutputEnabled, canConfirmPlayback: () => playback, onState: vi.fn(), onError, onDone });
  await coordinator.start();
  const result = await coordinator.claimTool();
  expect(result.status).toBe('granted');
  coordinator.toolFinished();
  const speech = requestResponse.mock.calls.at(-1)![0];
  coordinator.receive({ type: 'response.created', response: { id: 'speech', metadata: speech.metadata } });
  const event = (type: string, transcript = String(number)) => coordinator.receive(type === 'response.done'
    ? { type, response: { id: 'speech', status: 'completed', output: [{ content: [{ transcript }] }] } }
    : { type, response_id: 'speech', transcript });
  return { coordinator, request, requestResponse, onError, onDone, event, setOutputEnabled };
}

test('generation completion alone cannot release a turn; playback completion releases once and calls the tool again', async () => {
  const t = await setup();
  t.event('output_audio_buffer.started');
  t.event('response.output_audio.done');
  t.event('response.done');
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.request.mock.calls.filter(([action]) => action === 'complete')).toHaveLength(0);
  t.event('output_audio_buffer.stopped');
  t.event('output_audio_buffer.stopped');
  await vi.advanceTimersByTimeAsync(350);
  expect(t.request.mock.calls.filter(([action]) => action === 'complete')).toHaveLength(1);
  expect(t.requestResponse.mock.calls.at(-1)![0].tool_choice).toEqual({ type: 'function', name: 'get_latest_count' });
  t.coordinator.stop();
});

test.each(['two', 'one two', 'the number is one', ''])('unexpected speech %j blocks the shared run', async (transcript) => {
  const t = await setup();
  t.event('output_audio_buffer.started'); t.event('response.done', transcript); t.event('output_audio_buffer.stopped');
  await vi.advanceTimersByTimeAsync(500);
  expect(t.onError).toHaveBeenCalledOnce();
  expect(t.request.mock.calls.some(([action]) => action === 'complete')).toBe(false);
  expect(t.request.mock.calls.some(([action]) => action === 'cancel')).toBe(true);
  expect(t.setOutputEnabled).toHaveBeenLastCalledWith(false);
});

test('blocked browser playback and interrupted audio never advance the count', async () => {
  const t = await setup({ playback: false });
  t.event('output_audio_buffer.started'); t.event('response.done'); t.event('output_audio_buffer.stopped');
  expect(t.onError).toHaveBeenCalledOnce();
  expect(t.request.mock.calls.some(([action]) => action === 'complete')).toBe(false);
  const interrupted = await setup();
  interrupted.event('output_audio_buffer.cleared');
  expect(interrupted.onError).toHaveBeenCalledOnce();
});

test('unrelated responses and cancellation cannot complete a turn', async () => {
  const t = await setup();
  t.coordinator.receive({ type: 'output_audio_buffer.stopped', response_id: 'unrelated' });
  await vi.advanceTimersByTimeAsync(3100);
  expect(t.request.mock.calls.some(([action]) => action === 'complete')).toBe(false);
  t.coordinator.stop();
  t.event('response.done'); t.event('output_audio_buffer.started'); t.event('output_audio_buffer.stopped');
  await vi.advanceTimersByTimeAsync(500);
  expect(t.request.mock.calls.some(([action]) => action === 'complete')).toBe(false);
});

test('the hundredth completed playback closes the session without requesting another turn', async () => {
  const t = await setup({ number: 100 });
  t.event('output_audio_buffer.started'); t.event('output_audio_buffer.stopped'); t.event('response.done', 'One hundred.');
  await vi.advanceTimersByTimeAsync(350);
  expect(t.onDone).toHaveBeenCalledOnce();
  expect(t.requestResponse).toHaveBeenCalledTimes(2);
});

test('spoken number validation accepts words and digits, but rejects extra numbers', () => {
  expect(isExpectedNumber('Ninety-nine.', 99)).toBe(true);
  expect(isExpectedNumber('100.', 100)).toBe(true);
  expect(isExpectedNumber('99, 100', 100)).toBe(false);
});
