import { counterRequest, type CountResult } from './counter-api';

type TalkingStickResult = Exclude<CountResult, { status: 'waiting' }> | { status: 'cancelled' };

export class CounterLock {
  private attempt: AbortController | null = null;
  private pending: Promise<TalkingStickResult> | null = null;

  constructor(private clientId: string, private signal: AbortSignal, private request = counterRequest) {}

  getTalkingStick = (): Promise<TalkingStickResult> => {
    return this.pending ??= this.waitForGrant().finally(() => { this.pending = null; });
  };

  private async waitForGrant(): Promise<TalkingStickResult> {
    const attempt = new AbortController();
    this.attempt = attempt;
    const signal = AbortSignal.any([this.signal, attempt.signal]);
    try {
      const result = await this.request<TalkingStickResult>('claim', { clientId: this.clientId }, signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted) return { status: 'cancelled' };
      throw error;
    } finally {
      if (this.attempt === attempt) this.attempt = null;
    }
  }

  cancel = () => { this.attempt?.abort(); };

}
