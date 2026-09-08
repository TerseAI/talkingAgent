import { Actor, type ActorSocket, type ActorSocketMessage } from 'little-durable-objects';
import { logCountingEvent } from '../shared/agent-identity.mjs';
import { TARGET_COUNT, countingCommandSchema, participantIdSchema } from '../shared/counting-protocol.mjs';

export type Participant = { participantId: string; joinOrder: number };
export type Speaker = { participantId: string; socketId: string; joinOrder: number; turnId: string };

/**
 * Owns the shared count and rotates turns round-robin over connected participants.
 * Browsers start, stop, and complete turns; the actor never waits on a model.
 */
export class CountingRoom extends Actor {
  nextNumber = 1;
  counting = false;
  currentSpeaker: Speaker | null = null;
  joined = 0;
  /** Join order of the speaker interrupted by a pause, so resume returns to them. */
  pausedAt: number | null = null;

  async onConnect(socket: ActorSocket<Participant>) {
    const participantId = participantIdSchema.safeParse(socket.metadata?.participantId);
    if (!participantId.success) {
      socket.reject(4000, 'Invalid participant identity.');
      return;
    }
    // Other sockets are not visible inside onConnect, so the order comes from a saved counter.
    const joinOrder = (this.joined ?? 0) + 1;
    this.joined = joinOrder;
    socket.metadata = { participantId: participantId.data, joinOrder };
    logCountingEvent('connected', participantId.data, `socketId=${socket.id} joinOrder=${joinOrder}`);
    socket.send(JSON.stringify({ type: 'ready' }));
    // A participant joining a running count with no speaker takes the next number.
    if (this.counting && !this.currentSpeaker) {
      this.#assignNext(joinOrder - 1);
      this.#broadcastState();
    }
  }

  async onMessage(socket: ActorSocket<Participant>, message: ActorSocketMessage) {
    const parsed = countingCommandSchema.safeParse(safeJson(String(message)));
    if (!parsed.success) { socket.send(JSON.stringify({ type: 'error', message: 'Invalid counting command.' })); return; }
    const command = parsed.data;
    switch (command.type) {
      case 'start_count': return this.#onStart(socket, command.requestId);
      case 'pause_count': return this.#onPause(socket, command.requestId);
      case 'reset_count': return this.#onReset(socket, command.requestId);
      case 'complete_turn': return this.#onTurnEnded(socket, command.turnId, 'completed');
      case 'expire_turn': return this.#onTurnEnded(socket, command.turnId, 'expired; assumed spoken');
    }
  }

  async onDisconnect(socket: ActorSocket<Participant>) {
    logCountingEvent('disconnected', socket.metadata?.participantId, `socketId=${socket.id}`);
    if (this.currentSpeaker?.socketId === socket.id) {
      logCountingEvent('released unfinished turn', this.currentSpeaker.participantId, `number=${this.nextNumber} turnId=${this.currentSpeaker.turnId}`);
      this.currentSpeaker = null;
      this.#assignNext(socket.metadata?.joinOrder ?? 0);
    }
    this.#broadcastState();
  }

  async getSnapshot() { return this.#snapshot(); }

  #onStart(socket: ActorSocket<Participant>, requestId: string) {
    if (this.nextNumber <= TARGET_COUNT) {
      this.counting = true;
      logCountingEvent('count started', socket.metadata.participantId, `next number=${this.nextNumber}`);
      // Resume with the interrupted speaker; otherwise the participant who was asked speaks first.
      if (!this.currentSpeaker) this.#assignNext((this.pausedAt ?? socket.metadata.joinOrder) - 1);
      this.pausedAt = null;
    }
    socket.send(JSON.stringify({ type: 'ack', requestId }));
    this.#broadcastState();
  }

  #onPause(socket: ActorSocket<Participant>, requestId: string) {
    logCountingEvent('count paused', socket.metadata.participantId, `next number=${this.nextNumber} speaker=${this.currentSpeaker?.participantId ?? 'none'}`);
    if (this.currentSpeaker) this.pausedAt = this.currentSpeaker.joinOrder;
    this.counting = false;
    this.currentSpeaker = null;
    socket.send(JSON.stringify({ type: 'ack', requestId }));
    this.#broadcastState();
  }

  #onReset(socket: ActorSocket<Participant>, requestId: string) {
    logCountingEvent('reset count', socket.metadata.participantId, 'next number=1');
    this.nextNumber = 1;
    this.counting = false;
    this.currentSpeaker = null;
    this.pausedAt = null;
    socket.send(JSON.stringify({ type: 'ack', requestId }));
    this.#broadcastState();
  }

  #onTurnEnded(socket: ActorSocket<Participant>, turnId: string, reason: string) {
    const speaker = this.currentSpeaker;
    if (!speaker || speaker.socketId !== socket.id || speaker.turnId !== turnId) return;
    logCountingEvent(`turn ${reason}`, speaker.participantId, `number=${this.nextNumber} turnId=${turnId}`);
    this.nextNumber += 1;
    this.currentSpeaker = null;
    this.#assignNext(speaker.joinOrder);
    this.#broadcastState();
  }

  /** Assigns the next number to the first open participant after `afterJoinOrder`, wrapping around. */
  #assignNext(afterJoinOrder: number) {
    if (this.nextNumber > TARGET_COUNT) { this.counting = false; return; }
    if (!this.counting) return;
    const participants = this.#participants().sort((a, b) => a.metadata.joinOrder - b.metadata.joinOrder || a.id.localeCompare(b.id));
    const next = participants.find(({ metadata }) => metadata.joinOrder > afterJoinOrder) ?? participants[0];
    if (!next) return;
    this.currentSpeaker = { participantId: next.metadata.participantId, socketId: next.id, joinOrder: next.metadata.joinOrder, turnId: crypto.randomUUID() };
    logCountingEvent('assigned turn', next.metadata.participantId, `number=${this.nextNumber} turnId=${this.currentSpeaker.turnId}`);
  }

  #participants() {
    return this.connections.filter((socket) => socket.state === 'open' && socket.metadata) as ActorSocket<Participant>[];
  }

  #broadcastState() {
    this.broadcast(JSON.stringify({ type: 'state_changed', state: this.#snapshot(), turnId: this.currentSpeaker?.turnId ?? null }));
  }

  #snapshot() {
    return {
      nextNumber: this.nextNumber, completedCount: this.nextNumber - 1, targetCount: TARGET_COUNT,
      currentSpeakerId: this.currentSpeaker?.participantId ?? null, counting: this.counting, finished: this.nextNumber > TARGET_COUNT,
    };
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}
