import { counterRequest, type CountResult } from './counter-api';

type Connection = { addEventListener(type: string, listener: () => void): void; close(): void };

export class CounterLock {
  private ready = false;
  private revision = 0;
  private listeners = new Set<() => void>();
  private attempt: AbortController | null = null;
  private pending: Promise<CountResult | { status: 'cancelled' }> | null = null;

  constructor(
    private clientId: string,
    private signal: AbortSignal,
    private connection: Connection,
    private request = counterRequest,
  ) {
    connection.addEventListener('ready', () => { this.ready = true; this.wake(); });
    connection.addEventListener('turn', () => this.wake());
    connection.addEventListener('error', () => { this.ready = false; });
    signal.addEventListener('abort', () => { this.cancel(); connection.close(); }, { once: true });
  }

  claim = (): Promise<CountResult | { status: 'cancelled' }> => {
    return this.pending ??= this.waitForGrant().finally(() => { this.pending = null; });
  };

  private async waitForGrant(): Promise<CountResult | { status: 'cancelled' }> {
    const attempt = new AbortController();
    this.attempt = attempt;
    const signal = AbortSignal.any([this.signal, attempt.signal]);
    try {
      while (true) {
        signal.throwIfAborted();
        const revision = this.revision;
        if (this.ready) {
          const result = await this.request<CountResult>('claim', { clientId: this.clientId }, signal);
          signal.throwIfAborted();
          if (result.status !== 'waiting') return result;
        }
        await this.changed(revision, signal);
      }
    } catch (error) {
      if (signal.aborted) return { status: 'cancelled' };
      throw error;
    } finally {
      if (this.attempt === attempt) this.attempt = null;
    }
  }

  cancel = () => { this.attempt?.abort(); };

  private wake() {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }

  private changed(revision: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.listeners.delete(changed); signal.removeEventListener('abort', aborted); };
      const changed = () => { cleanup(); resolve(); };
      const aborted = () => { cleanup(); reject(signal.reason); };
      this.listeners.add(changed);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      else if (this.revision !== revision) changed();
    });
  }
}
