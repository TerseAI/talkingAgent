import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import type { CountingConnection } from './counting-connection';

export function createCountingTools(connection: Pick<CountingConnection, 'waitForTurn' | 'reportTurnComplete'>) {
  return [
    tool({
      name: 'wait_for_turn',
      description: 'Request a counting turn and wait silently until it is assigned to you. Call once; do not retry while pending. On granted, speak numberToSpeak aloud exactly once, then call report_turn_complete. On finished or cancelled, stop counting. Takes no arguments.',
      parameters: z.object({}),
      execute: connection.waitForTurn,
    }),
    tool({
      name: 'report_turn_complete',
      description: 'Report that you have finished saying the number assigned to you. Call exactly once after speaking. Advances the count and allows the next participant to speak. This trusts your report and cannot verify audio. Returns a completion acknowledgment. After completed, call wait_for_turn again. Takes no arguments.',
      parameters: z.object({}),
      execute: connection.reportTurnComplete,
    }),
  ];
}
