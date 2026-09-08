import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import type { CounterLock } from './counter-lock';
import { counterRequest } from './counter-api';

export function createCounterTools(clientId: string, signal: AbortSignal, getTalkingStick: CounterLock['getTalkingStick'], request = counterRequest) {
  return [
    tool({
      name: 'getTalkingStick',
      description: 'Acquire your next counting turn. Call once and wait silently until it returns; do not retry while pending. On granted, speak next_number aloud exactly once, THEN call done_speaking. A grant is not spoken audio and is not a completed turn. On done or cancelled, stop counting. Takes no arguments.',
      parameters: z.object({}),
      execute: getTalkingStick,
    }),
    tool({
      name: 'done_speaking',
      description: 'Call exactly once AFTER you have spoken the number from your current grant. Records that number as completed and releases the talking stick so another agent can proceed. Never call before speaking: this tool trusts your report and cannot verify audio. Takes no arguments and returns only a completion acknowledgment, not another number. After completed, immediately call getTalkingStick for your next turn.',
      parameters: z.object({}),
      execute: () => request('complete', { clientId }, signal),
    }),
  ];
}
