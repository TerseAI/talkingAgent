import type { z } from 'zod';
import type { countingSnapshotSchema } from '../shared/counting-protocol.mjs';

export type CountingSnapshot = z.infer<typeof countingSnapshotSchema>;
export type CountCommandResult = { status: 'ok' } | { status: 'cancelled' };

export async function fetchCountingSnapshot(signal?: AbortSignal): Promise<CountingSnapshot> {
  const response = await fetch('/api/counting', {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? 'The counting room is unavailable.');
  return data as CountingSnapshot;
}
