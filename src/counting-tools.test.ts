import { RunContext } from '@openai/agents';
import { expect, it, vi } from 'vitest';
import { createCountingTools } from './counting-tools';

it('keeps the SDK tool pending until the connection receives a turn grant', async () => {
  let grant!: (value: { status: 'granted'; completedCount: number; numberToSpeak: number; targetCount: 100 }) => void;
  const waitForTurn = vi.fn(() => new Promise<{ status: 'granted'; completedCount: number; numberToSpeak: number; targetCount: 100 }>((resolve) => { grant = resolve; }));
  const tools = createCountingTools({ waitForTurn: waitForTurn, reportTurnComplete: vi.fn() });
  const completed = vi.fn();
  const result = tools.find((tool) => tool.name === 'wait_for_turn')!.invoke(new RunContext(), '{}').then(completed);
  await vi.waitFor(() => expect(waitForTurn).toHaveBeenCalledOnce());
  expect(completed).not.toHaveBeenCalled();
  grant({ status: 'granted', completedCount: 1, numberToSpeak: 2, targetCount: 100 });
  await result;
  expect(completed).toHaveBeenCalledWith({ status: 'granted', completedCount: 1, numberToSpeak: 2, targetCount: 100 });
});

it('delegates completion to the same counting connection', async () => {
  const reportTurnComplete = vi.fn().mockResolvedValue({ status: 'completed' });
  const tools = createCountingTools({ waitForTurn: vi.fn(), reportTurnComplete });
  await tools.find((tool) => tool.name === 'report_turn_complete')!.invoke(new RunContext(), '{}');
  expect(reportTurnComplete).toHaveBeenCalledOnce();
  expect(tools.map((tool) => tool.name)).toEqual(['wait_for_turn', 'report_turn_complete']);
});
