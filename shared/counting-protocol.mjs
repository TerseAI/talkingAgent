import { z } from 'zod';

export const TARGET_COUNT = 100;
// Upper bound on one spoken number. Normal turns end when the browser reports that playback stopped.
export const TURN_FALLBACK_MS = 8_000;

export const participantIdSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^(Alice|Bob|Charlie|Assistant):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
]);

const requestId = z.string().uuid();
const turnId = z.string().uuid();

export const countingCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start_count'), requestId }),
  z.object({ type: z.literal('pause_count'), requestId }),
  z.object({ type: z.literal('reset_count'), requestId }),
  z.object({ type: z.literal('complete_turn'), turnId }),
  z.object({ type: z.literal('expire_turn'), turnId }),
]);

export const countingSnapshotSchema = z.object({
  nextNumber: z.number().int().min(1).max(TARGET_COUNT + 1),
  completedCount: z.number().int().min(0).max(TARGET_COUNT),
  targetCount: z.literal(TARGET_COUNT),
  currentSpeakerId: z.string().nullable(),
  counting: z.boolean(),
  finished: z.boolean(),
});

export const countingEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('ack'), requestId: z.string().uuid() }),
  z.object({ type: z.literal('state_changed'), state: countingSnapshotSchema, turnId: z.string().uuid().nullable() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  // The DO gateway also sends an initial actor snapshot on connection.
  z.object({ type: z.literal('state'), state: z.unknown() }),
]);
