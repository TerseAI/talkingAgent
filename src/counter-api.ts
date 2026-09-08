import type { Counter } from './durable-objects';

export type CounterSnapshot = Awaited<ReturnType<Counter['getState']>>;
export type CountResult = Awaited<ReturnType<Counter['getLatestCount']>>;

export async function counterRequest<T>(action = '', body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/counter${action ? `/${action}` : ''}`, {
    method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    keepalive: action === 'cancel',
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? 'The shared counter is unavailable.');
  return data as T;
}
