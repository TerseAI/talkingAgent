import { z } from 'zod';

export const participantIdSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^(Alice|Bob|Charlie|Assistant):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
]);
export const countingCommandSchema = z.object({
  type: z.enum(['request_turn', 'report_turn_complete', 'reset_count']),
  requestId: z.string().uuid(),
});

const countingSnapshotSchema = z.object({
  nextNumber: z.number().int().min(1).max(101),
  completedCount: z.number().int().min(0).max(100),
  targetCount: z.literal(100),
  currentSpeakerId: z.string().nullable(),
  finished: z.boolean(),
});

export const countingEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('turn_changed'), state: countingSnapshotSchema, turnRequestId: z.string().uuid().nullable() }),
  z.object({ type: z.literal('turn_completed'), requestId: z.string().uuid() }),
  z.object({ type: z.literal('count_reset'), requestId: z.string().uuid(), state: countingSnapshotSchema }),
  z.object({ type: z.literal('error'), message: z.string() }),
  // The DO gateway sends this initial actor snapshot before application messages.
  z.object({ type: z.literal('state'), state: z.unknown() }),
]);
