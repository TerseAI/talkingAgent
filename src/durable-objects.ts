import { Actor as DurableObject } from 'little-durable-objects';

import { logCounter } from '../shared/agent-identity.mjs';

export class Counter extends DurableObject {
  number = 1;
  talkingStick: string | null = null;

  async tryGetTalkingStick(agentId: string) {
    if (this.number > 100) return { status: 'done' as const, count: 100, target: 100 };
    if (this.talkingStick && this.talkingStick !== agentId) return { status: 'waiting' as const };
    if (this.talkingStick !== agentId) logCounter('acquired turn', agentId, `number=${this.number}`);
    this.talkingStick = agentId;
    return { status: 'granted' as const, latest_count: this.number - 1, next_number: this.number, target: 100 };
  }

  async doneSpeaking(agentId: string) {
    if (this.talkingStick !== agentId) throw new Error('You do not hold the talking stick. Call getTalkingStick before speaking.');
    logCounter('reported done_speaking', agentId, `number=${this.number}`);
    this.number += 1;
    this.talkingStick = null;
    return { status: 'completed' as const };
  }

  async getState() {
    return { number: this.number, talkingStick: this.talkingStick, count: this.number - 1, target: 100, done: this.number > 100 };
  }

  async stop(agentId: string) {
    if (this.talkingStick === agentId) {
      logCounter('released/cancelled', agentId);
      this.talkingStick = null;
    }
    return this.getState();
  }

  async reset() {
    logCounter('reset', null, 'next number=1');
    this.number = 1;
    this.talkingStick = null;
    return this.getState();
  }
}
