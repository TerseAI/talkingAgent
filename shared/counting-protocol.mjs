import { z } from 'zod';

export const TARGET_COUNT = 100;

export const participantIdSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
]);

export const countingStateSchema = z.object({
  count: z.number().int().min(0).max(TARGET_COUNT),
  running: z.boolean(),
});

export const countingEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state_changed'), state: countingStateSchema, speakerId: z.string().nullable() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('state'), state: countingStateSchema }),
]);
