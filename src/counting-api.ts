import type { CountingRoom } from './counting-room';

export type CountingSnapshot = Awaited<ReturnType<CountingRoom['getSnapshot']>>;
export type TurnGrantResult =
  | { status: 'granted'; completedCount: number; numberToSpeak: number; targetCount: 100 }
  | { status: 'finished'; completedCount: 100; targetCount: 100 }
  | { status: 'cancelled' };
export type TurnCompletionResult = { status: 'completed' } | { status: 'cancelled' };
export type CountResetResult = { status: 'reset' } | { status: 'cancelled' };

export async function fetchCountingSnapshot(signal?: AbortSignal): Promise<CountingSnapshot> {
  const response = await fetch('/api/counting', {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? 'The counting room is unavailable.');
  return data as CountingSnapshot;
}
