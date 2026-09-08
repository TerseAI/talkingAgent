import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import type { CountingConnection } from './counting-connection';

/**
 * The model decides whether the group counts. It never paces turns: the room cues each
 * number directly into the live session, and the browser reports when playback ends.
 */
export function createCountingTools(connection: Pick<CountingConnection, 'startCount' | 'pauseCount'>) {
  return [
    tool({
      name: 'start_counting',
      description: 'Start or resume the shared group count to 100 when the user asks. A resumed count continues from where it paused. The room will cue you with each number that is yours to say. After this returns, stay silent; do not announce that counting has started. Takes no arguments.',
      parameters: z.object({}),
      execute: connection.startCount,
    }),
    tool({
      name: 'pause_counting',
      description: 'Pause the shared group count for every participant so the user can talk. The count keeps its place and start_counting resumes it. Call when the user asks to pause or stop, or changes the subject while the group is counting. Takes no arguments.',
      parameters: z.object({}),
      execute: connection.pauseCount,
    }),
  ];
}
