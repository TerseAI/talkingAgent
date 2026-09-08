import { Actor as DurableObject, type ActorSocket } from 'little-durable-objects';

export class Counter extends DurableObject {
  number = 1;
  talkingStick: string | null = null;
  waiting: string[] = [];

  async onConnect(socket: ActorSocket<{ clientId: string }>) {
    socket.setTags(socket.metadata.clientId);
  }

  async onDisconnect(socket: ActorSocket<{ clientId: string }>) {
    if (this.connections.some((other) => other.id !== socket.id && other.tags.includes(socket.metadata.clientId))) return;
    await this.stop(socket.metadata.clientId);
  }

  async getLatestCount(agentId: string) {
    if (this.number > 100) return { status: 'done' as const, count: 100, target: 100 };
    if (this.talkingStick && this.talkingStick !== agentId) {
      if (!this.waiting.includes(agentId)) this.waiting.push(agentId);
      return { status: 'waiting' as const };
    }
    this.talkingStick = agentId;
    return { status: 'granted' as const, latest_count: this.number - 1, next_number: this.number, target: 100 };
  }

  async doneSpeaking(agentId: string, number: number) {
    if (number < this.number) return this.getState();
    if (this.talkingStick !== agentId || number !== this.number) throw new Error('This agent does not hold the talking stick for that number.');
    this.number += 1;
    this.#nextTurn();
    return this.getState();
  }

  async getState() {
    return { number: this.number, talkingStick: this.talkingStick, count: this.number - 1, target: 100, done: this.number > 100 };
  }

  async stop(agentId: string) {
    this.waiting = this.waiting.filter((id) => id !== agentId);
    if (this.talkingStick === agentId) this.#nextTurn();
    return this.getState();
  }

  async reset() {
    this.number = 1;
    this.talkingStick = null;
    this.waiting = [];
    return this.getState();
  }

  #nextTurn() {
    if (this.number > 100) {
      for (const agentId of this.waiting) {
        this.broadcast(JSON.stringify({ type: 'turn_available' }), { tags: [agentId] });
      }
      this.waiting = [];
    }
    this.talkingStick = this.waiting.shift() ?? null;
    if (this.talkingStick) {
      this.broadcast(JSON.stringify({ type: 'turn_available' }), { tags: [this.talkingStick] });
    }
  }
}
