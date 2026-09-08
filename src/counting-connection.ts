import { countingEventSchema } from '../shared/counting-protocol.mjs';
import type { CountCommandResult, CountingSnapshot } from './counting-api';
import { logVoiceEvent } from './voice-diagnostics';

type CountingSocket = Pick<WebSocket, 'send' | 'close' | 'addEventListener'>;
type CommandType = 'start_count' | 'pause_count' | 'reset_count';
type PendingCommand = { type: CommandType; requestId: string; resolve: (result: CountCommandResult) => void; reject: (error: Error) => void };
export type StateListener = (state: CountingSnapshot, turnId: string | null) => void;

const RECONNECT_DELAY_MS = 1_000;

/**
 * One browser's link to the CountingRoom. Sends commands, resolves their acknowledgments,
 * and reports every room broadcast to `onStateChanged`. Reconnects while the session lives.
 */
export class CountingConnection {
  onStateChanged: StateListener | null = null;
  private socket: CountingSocket | null = null;
  private actorReady = false;
  private pending: PendingCommand[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private participantId: string, private signal: AbortSignal, private openSocket = openCountingSocket) {
    signal.addEventListener('abort', this.close, { once: true });
  }

  /** Joins the room so this participant is eligible for turns and receives state broadcasts. */
  connect = () => { if (!this.signal.aborted && !this.socket) this.connectSocket(); };

  startCount = () => this.sendCommand('start_count');
  pauseCount = () => this.sendCommand('pause_count');
  resetCount = () => this.sendCommand('reset_count');

  /** Fire-and-forget: the room answers with a state broadcast, not an acknowledgment. */
  completeTurn = (turnId: string) => {
    this.log('complete_turn', { turnId });
    if (this.socket && this.actorReady) this.trySend({ type: 'complete_turn', turnId });
  };

  close = () => {
    this.log('close_requested');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.settlePending((command) => command.resolve({ status: 'cancelled' }));
    this.closeSocket();
  };

  private sendCommand(type: CommandType): Promise<CountCommandResult> {
    const requestId = crypto.randomUUID();
    this.log('command_requested', { type, requestId });
    if (this.signal.aborted) return Promise.resolve({ status: 'cancelled' });
    return new Promise<CountCommandResult>((resolve, reject) => {
      this.pending.push({ type, requestId, resolve, reject });
      if (!this.socket) this.connectSocket();
      if (this.actorReady) this.trySend({ type, requestId });
    });
  }

  private connectSocket() {
    this.log('socket_connecting');
    let socket: CountingSocket;
    try { socket = this.openSocket(this.participantId); }
    catch (error) { this.failConnection(error instanceof Error ? error : new Error(String(error))); return; }
    this.socket = socket;
    socket.addEventListener('message', (event) => { if (this.socket === socket) this.onMessage(String(event.data)); });
    socket.addEventListener('close', (event) => {
      this.log('socket_closed', { code: event.code, reason: event.reason, wasClean: event.wasClean, currentSocket: this.socket === socket });
      if (this.socket === socket) this.failConnection(new Error('The counting connection closed.'));
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) this.failConnection(new Error('Could not connect to the counting room. Check that the actor runtime is running.'));
    });
  }

  private onMessage(data: string) {
    const parsed = countingEventSchema.safeParse(safeJson(data));
    if (!parsed.success) { this.failConnection(new Error('The counting room sent an invalid socket message.')); return; }
    const message = parsed.data;
    if (message.type !== 'state') this.log('message_received', { message });
    switch (message.type) {
      case 'ready':
        if (this.actorReady) return;
        this.actorReady = true;
        for (const { type, requestId } of this.pending) this.trySend({ type, requestId });
        return;
      case 'ack': {
        const index = this.pending.findIndex((command) => command.requestId === message.requestId);
        if (index >= 0) this.pending.splice(index, 1)[0].resolve({ status: 'ok' });
        return;
      }
      case 'error': return this.failConnection(new Error(message.message));
      case 'state_changed':
        this.onStateChanged?.(message.state, message.turnId);
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('counting-state-changed'));
        return;
    }
  }

  private trySend(command: object) {
    try { this.socket!.send(JSON.stringify(command)); this.log('command_sent', command as Record<string, unknown>); }
    catch { this.failConnection(new Error('Could not send the counting command.')); }
  }

  private failConnection(error: Error) {
    this.log('connection_failed', { message: error.message });
    this.settlePending((command) => command.reject(error));
    this.closeSocket();
    // A live agent must not silently fall out of the count; rejoin while the voice session lives.
    if (!this.signal.aborted && this.onStateChanged && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, RECONNECT_DELAY_MS);
    }
  }

  private settlePending(settle: (command: PendingCommand) => void) {
    const pending = this.pending;
    this.pending = [];
    pending.forEach(settle);
  }

  private closeSocket() {
    const socket = this.socket;
    this.socket = null;
    this.actorReady = false;
    socket?.close();
  }

  private log(event: string, details: Record<string, unknown> = {}) {
    logVoiceEvent(this.participantId, `counting.${event}`, details);
  }
}

export async function resetSharedCount() {
  const signal = AbortSignal.timeout(10_000);
  const connection = new CountingConnection(crypto.randomUUID(), signal);
  try {
    await connection.resetCount();
    signal.throwIfAborted();
  } finally { connection.close(); }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function openCountingSocket(participantId: string): CountingSocket {
  const url = new URL('/api/counting/socket', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('participantId', participantId);
  return new WebSocket(url);
}
