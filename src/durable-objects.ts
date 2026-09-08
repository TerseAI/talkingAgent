import { Actor as DurableObject } from 'little-durable-objects';

export class Counter extends DurableObject {
  number = 1;
  talkingStick: string | null = null;

  async getLatestCount(agentId: string) {
    if (this.number > 100) return { status: 'done' as const, count: 100, target: 100 };
    if (this.talkingStick && this.talkingStick !== agentId) return { status: 'waiting' as const };
    this.talkingStick = agentId;
    return { status: 'granted' as const, latest_count: this.number - 1, next_number: this.number, target: 100 };
  }

  async doneSpeaking(agentId: string, number: number) {
    if (number < this.number) return this.getState();
    if (this.talkingStick !== agentId || number !== this.number) throw new Error('This agent does not hold the talking stick for that number.');
    this.number += 1;
    this.talkingStick = null;
    return this.getState();
  }

  async getState() {
    return { number: this.number, talkingStick: this.talkingStick, count: this.number - 1, target: 100, done: this.number > 100 };
  }

  async stop(agentId: string) {
    if (this.talkingStick === agentId) this.talkingStick = null;
    return this.getState();
  }

  async reset() {
    this.number = 1;
    this.talkingStick = null;
    return this.getState();
  }
}
