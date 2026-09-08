import { RunContext } from '@openai/agents';
import { expect, it, vi } from 'vitest';
import { createCountingTools } from './counting-tools';

it('exposes start and pause as the only model-facing counting decisions', async () => {
  const startCount = vi.fn(async () => ({ status: 'ok' as const }));
  const pauseCount = vi.fn(async () => ({ status: 'ok' as const }));
  const tools = createCountingTools({ startCount, pauseCount });
  expect(tools.map((tool) => tool.name)).toEqual(['start_counting', 'pause_counting']);
  expect(await tools[0].invoke(new RunContext(), '{}')).toEqual({ status: 'ok' });
  expect(startCount).toHaveBeenCalledOnce();
  expect(pauseCount).not.toHaveBeenCalled();
});
