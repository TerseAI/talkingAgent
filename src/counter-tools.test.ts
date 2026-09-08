import { RunContext } from '@openai/agents';
import { expect, it, vi } from 'vitest';
import { createCounterTools } from './counter-tools';

it('keeps the SDK tool pending until the lock grant resolves', async () => {
  let grant!: (value: { status: 'granted'; latest_count: number; next_number: number; target: number }) => void;
  const claim = vi.fn(() => new Promise<{ status: 'granted'; latest_count: number; next_number: number; target: number }>((resolve) => { grant = resolve; }));
  const tools = createCounterTools('agent-one', new AbortController().signal, claim);
  const completed = vi.fn();
  const result = tools.find((tool) => tool.name === 'getTalkingStick')!.invoke(new RunContext(), '{}').then(completed);
  await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
  expect(completed).not.toHaveBeenCalled();
  grant({ status: 'granted', latest_count: 1, next_number: 2, target: 100 });
  await result;
  expect(completed).toHaveBeenCalledWith({ status: 'granted', latest_count: 1, next_number: 2, target: 100 });
});

it('completes the reserved turn using only the session identity', async () => {
  const request = vi.fn().mockResolvedValue({ status: 'completed' });
  const signal = new AbortController().signal;
  const tools = createCounterTools('agent-two', signal, vi.fn(), request);
  await tools.find((tool) => tool.name === 'done_speaking')!.invoke(new RunContext(), '{}');
  expect(request).toHaveBeenCalledExactlyOnceWith('complete', { clientId: 'agent-two' }, signal);
  expect(tools.map((tool) => tool.name)).toEqual(['getTalkingStick', 'done_speaking']);
});
