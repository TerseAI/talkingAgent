import { Actor, Persisted, type ActorSocketOf } from 'durable-actors';
import { TARGET_COUNT } from '../shared/counting-protocol.mjs';

type Participant = { participantId: string };
type CountingEvent = { type: 'state_changed'; state: { count: number; running: boolean }; speakerId: string | null };

export class CountingRoom extends Actor<Participant, never, CountingEvent> {
  @Persisted count = 0;
  @Persisted running = false;

  async increment() {
    if (!this.running) return;
    this.count += 1;
    if (this.count === TARGET_COUNT) this.running = false;
    await this.#changed();
  }

  async start() {
    if (this.count < TARGET_COUNT) this.running = true;
    await this.#changed();
  }

  async pause() {
    this.running = false;
    await this.#changed();
  }

  async reset() {
    this.count = 0;
    this.running = false;
    await this.#changed();
  }

  async getState() { return this.#state(); }

  async onDisconnect(socket: ActorSocketOf<CountingRoom>) {
    const connected = [...await this.getConnections(), socket]
      .map(({ metadata }) => metadata.participantId);
    if (this.#speakerId(connected) === socket.metadata.participantId) await this.#changed();
  }

  async #changed() {
    const participantIds = (await this.getConnections()).map(({ metadata }) => metadata.participantId);
    this.broadcast({ type: 'state_changed', state: this.#state(), speakerId: this.#speakerId(participantIds) });
  }

  #state() {
    return { count: this.count, running: this.running };
  }

  #speakerId(participantIds: string[]) {
    if (!this.running) return null;
    const connected = [...new Set(participantIds)].sort();
    return connected[this.count % connected.length] ?? null;
  }
}
