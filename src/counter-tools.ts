import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import type { CounterLock } from './counter-lock';
import { counterRequest } from './counter-api';

export function createCounterTools(clientId: string, signal: AbortSignal, claim: CounterLock['claim'], request = counterRequest, cancel = () => {}) {
  return [
    tool({
      name: 'read_counter',
      description: 'Read the shared counter without taking a turn.',
      parameters: z.object({}),
      execute: () => request('', undefined, signal),
    }),
    tool({
      name: 'get_latest_count',
      description: 'Wait for the talking stick. Returns granted with next_number once your turn is reserved, done at 100, or cancelled if interrupted. Stay silent while this tool is pending.',
      parameters: z.object({}),
      execute: claim,
    }),
    tool({
      name: 'done_speaking',
      description: 'Report the number you have spoken and release the talking stick. This records your report; it does not verify audio playback.',
      parameters: z.object({ number: z.number().int().min(1).max(100) }),
      execute: ({ number }) => request('complete', { clientId, number }, signal),
    }),
    tool({
      name: 'release_turn',
      description: 'Release your talking stick without advancing the count, for example when stopping or interrupted.',
      parameters: z.object({}),
      execute: () => { cancel(); return request('cancel', { clientId }, signal); },
    }),
  ];
}
