import { logCounter } from '../shared/agent-identity.mjs';

export class TurnCoordinator {
  constructor(counter) {
    this.counter = counter;
    this.waiters = [];
    this.operations = Promise.resolve();
  }

  getState() { return this.counter.getState(); }

  getTalkingStick(clientId, signal) {
    return new Promise((resolve, reject) => {
      const waiter = { clientId, signal, resolve, reject };
      const abort = () => { void this.cancel(clientId).catch(reject); };
      signal?.addEventListener('abort', abort, { once: true });
      waiter.cleanup = () => signal?.removeEventListener('abort', abort);
      this.run(async () => {
        if (signal?.aborted) { this.finish(waiter, { status: 'cancelled' }); return; }
        const state = await this.counter.getState();
        if (state.talkingStick === clientId) {
          this.finish(waiter, await this.counter.tryGetTalkingStick(clientId));
          return;
        }
        if (this.waiters.some((entry) => entry.clientId === clientId)) throw new Error('This agent already has a pending turn request.');
        this.waiters.push(waiter);
        logCounter('waiting for turn', clientId, `queue position=${this.waiters.length}`);
        await this.handoff();
      }).catch((error) => { waiter.cleanup(); reject(error); });
    });
  }

  doneSpeaking(clientId) {
    return this.run(async () => {
      const result = await this.counter.doneSpeaking(clientId);
      await this.handoff();
      return result;
    });
  }

  cancel(clientId) {
    return this.run(async () => {
      const cancelled = this.waiters.filter((entry) => entry.clientId === clientId);
      this.waiters = this.waiters.filter((entry) => entry.clientId !== clientId);
      cancelled.forEach((entry) => this.finish(entry, { status: 'cancelled' }));
      const state = await this.counter.stop(clientId);
      await this.handoff();
      return state;
    });
  }

  reset() {
    return this.run(async () => {
      this.waiters.splice(0).forEach((entry) => this.finish(entry, { status: 'cancelled' }));
      return this.counter.reset();
    });
  }

  close() {
    return this.run(async () => {
      this.waiters.splice(0).forEach((entry) => this.finish(entry, { status: 'cancelled' }));
      const state = await this.counter.getState();
      if (state.talkingStick) await this.counter.stop(state.talkingStick);
    });
  }

  async handoff() {
    try {
      const state = await this.counter.getState();
      if (state.done) {
        this.waiters.splice(0).forEach((entry) => this.finish(entry, { status: 'done', count: 100, target: 100 }));
        return;
      }
      if (state.talkingStick) return;
      while (this.waiters[0]?.signal?.aborted) this.finish(this.waiters.shift(), { status: 'cancelled' });
      const next = this.waiters[0];
      if (!next) return;
      const grant = await this.counter.tryGetTalkingStick(next.clientId);
      if (grant.status === 'waiting') throw new Error('Another coordinator owns this counter. Run only one npm run dev process.');
      this.waiters.shift();
      this.finish(next, grant);
    } catch (error) {
      this.waiters.splice(0).forEach((entry) => { entry.cleanup(); entry.reject(error); });
      throw error;
    }
  }

  finish(waiter, result) { waiter.cleanup(); waiter.resolve(result); }

  run(operation) {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => {});
    return result;
  }
}
