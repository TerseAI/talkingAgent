import { Actor, type ActorSocket, type ActorSocketMessage } from 'little-durable-objects';
import { logCountingEvent } from '../shared/agent-identity.mjs';
import { countingCommandSchema, participantIdSchema } from '../shared/counting-protocol.mjs';

export type Participant = {
  participantId: string;
  socketId: string;
  turnRequestId: string | null;
  waitingOrder: number | null;
};

export class CountingRoom extends Actor {
  nextNumber = 1;
  currentSpeaker: Participant | null = null;

  async onConnect(socket: ActorSocket<{ participantId: string }>) {
    if (!participantIdSchema.safeParse(socket.metadata?.participantId).success) {
      socket.reject(4000, 'Invalid participant identity.');
      return;
    }
    const participant: Participant = {
      participantId: socket.metadata.participantId, socketId: socket.id,
      turnRequestId: null, waitingOrder: null,
    };
    socket.metadata = participant;
    socket.send(JSON.stringify({ type: 'ready' }));
  }

  async onMessage(socket: ActorSocket<Participant>, message: ActorSocketMessage) {
    let command;
    try { command = countingCommandSchema.parse(JSON.parse(String(message))); }
    catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid counting command.' }));
      return;
    }
    switch (command.type) {
      case 'reset_count': return this.#onResetCount(command.requestId);
      case 'report_turn_complete': return this.#onTurnComplete(socket, command.requestId);
      case 'request_turn': return this.#onTurnRequested(socket, command.requestId);
    }
  }

  async onDisconnect(socket: ActorSocket<Participant>) {
    if (this.currentSpeaker?.socketId === socket.id) {
      logCountingEvent('released unfinished turn', this.currentSpeaker.participantId);
      this.currentSpeaker = null;
    }
    this.#assignAndBroadcastTurn();
  }

  async getSnapshot() { return this.#snapshot(); }

  #onResetCount(requestId: string) {
    logCountingEvent('reset count', null, 'next number=1');
    this.nextNumber = 1;
    this.currentSpeaker = null;
    for (const participant of this.connections as ActorSocket<Participant>[]) {
      participant.metadata = { ...participant.metadata, turnRequestId: null, waitingOrder: null };
    }
    this.broadcast(JSON.stringify({ type: 'count_reset', requestId, state: this.#snapshot() }));
  }

  #onTurnComplete(socket: ActorSocket<Participant>, requestId: string) {
    if (this.currentSpeaker?.socketId !== socket.id || this.currentSpeaker.turnRequestId !== requestId) {
      socket.send(JSON.stringify({ type: 'error', message: 'This turn is not assigned to you. Call wait_for_turn before speaking.' }));
      return;
    }
    logCountingEvent('reported turn complete', this.currentSpeaker.participantId, `number=${this.nextNumber}`);
    this.nextNumber += 1;
    this.currentSpeaker = null;
    this.#assignAndBroadcastTurn();
    socket.send(JSON.stringify({ type: 'turn_completed', requestId }));
  }

  #onTurnRequested(socket: ActorSocket<Participant>, requestId: string) {
    if (this.nextNumber > 100) { this.#assignAndBroadcastTurn(); return; }
    const participant = socket.metadata;
    const isCurrentSpeaker = this.currentSpeaker?.socketId === socket.id;
    const isWaiting = participant.waitingOrder !== null;
    if ((isCurrentSpeaker || isWaiting) && participant.turnRequestId !== requestId) {
      socket.send(JSON.stringify({ type: 'error', message: 'This connection already has a turn request.' }));
      return;
    }
    if (!isCurrentSpeaker && !isWaiting) {
      const waitingOrders = (this.connections as ActorSocket<Participant>[]).map(({ metadata }) => metadata.waitingOrder ?? -1);
      socket.metadata = { ...participant, turnRequestId: requestId, waitingOrder: Math.max(-1, ...waitingOrders) + 1 };
      logCountingEvent('requested turn', participant.participantId);
    }
    this.#assignAndBroadcastTurn();
  }

  #assignAndBroadcastTurn() {
    const participantSockets = this.connections.filter((socket) => socket.state === 'open') as ActorSocket<Participant>[];
    const currentSpeaker = this.currentSpeaker;
    if (currentSpeaker && !participantSockets.some((socket) => socket.id === currentSpeaker.socketId)) this.currentSpeaker = null;
    if (this.nextNumber > 100) this.currentSpeaker = null;
    else if (!this.currentSpeaker) {
      const nextSpeakerSocket = participantSockets
        .filter(({ metadata }) => metadata.waitingOrder !== null)
        .sort((a, b) => a.metadata.waitingOrder! - b.metadata.waitingOrder!)[0];
      if (nextSpeakerSocket) {
        nextSpeakerSocket.metadata = { ...nextSpeakerSocket.metadata, waitingOrder: null };
        this.currentSpeaker = nextSpeakerSocket.metadata;
        logCountingEvent('assigned turn', this.currentSpeaker.participantId, `number=${this.nextNumber}`);
      }
    }
    this.broadcast(JSON.stringify({ type: 'turn_changed', state: this.#snapshot(), turnRequestId: this.currentSpeaker?.turnRequestId ?? null }));
  }

  #snapshot() {
    return { nextNumber: this.nextNumber, currentSpeakerId: this.currentSpeaker?.participantId ?? null, completedCount: this.nextNumber - 1, targetCount: 100 as const, finished: this.nextNumber > 100 };
  }
}
