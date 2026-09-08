import { RunContext } from '@openai/agents';
import { expect, it, vi } from 'vitest';
import { createCounterTools } from './counter-tools';

it('keeps the SDK tool pending until the lock grant resolves', async () => {
  let grant!: (value: { status: 'granted'; latest_count: number; next_number: number; target: number }) => void;
  const claim = vi.fn(() => new Promise<{ status: 'granted'; latest_count: number; next_number: number; target: number }>((resolve) => { grant = resolve; }));
  const tools = createCounterTools('agent-one', new AbortController().signal, claim);
  const completed = vi.fn();
  const result = tools[1].invoke(new RunContext(), '{}').then(completed);
  await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
  expect(completed).not.toHaveBeenCalled();
  grant({ status: 'granted', latest_count: 1, next_number: 2, target: 100 });
  await result;
  expect(completed).toHaveBeenCalledWith({ status: 'granted', latest_count: 1, next_number: 2, target: 100 });
});

it('records only the number supplied by the model and binds calls to this session identity', async () => {
  const request = vi.fn().mockResolvedValue({ count: 7 });
  const signal = new AbortController().signal;
  const tools = createCounterTools('agent-two', signal, vi.fn(), request);
  await tools[2].invoke(new RunContext(), '{"number":7}');
  expect(request).toHaveBeenCalledExactlyOnceWith('complete', { clientId: 'agent-two', number: 7 }, signal);
  await tools[3].invoke(new RunContext(), '{}');
  expect(request).toHaveBeenLastCalledWith('cancel', { clientId: 'agent-two' }, signal);
});
