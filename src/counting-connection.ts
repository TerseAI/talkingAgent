import { countingEventSchema } from '../shared/counting-protocol.mjs';
import type { CountCommandResult, CountingState } from './counting-api';
import { logVoiceEvent } from './voice-diagnostics';

type CountingSocket = Pick<WebSocket, 'close' | 'addEventListener'>;
type ActorMethod = 'start' | 'pause' | 'reset' | 'increment';
type ActorCaller = (method: ActorMethod, signal: AbortSignal) => Promise<void>;
export type StateListener = (state: CountingState, speakerId: string | null) => void;

const RECONNECT_DELAY_MS = 1_000;

/**
 * One browser's receive-only link to the CountingRoom. Method calls use the web server.
 */
export class CountingConnection {
  onStateChanged: StateListener | null = null;
  private socket: CountingSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private participantId: string, private signal: AbortSignal, private openSocket = openCountingSocket, private callActor = callCountingActor) {
    signal.addEventListener('abort', this.close, { once: true });
  }

  /** Joins the room so this participant is eligible for turns and receives state broadcasts. */
  connect = () => { if (!this.signal.aborted && !this.socket) this.connectSocket(); };

  startCount = () => this.invoke('start');
  pauseCount = () => this.invoke('pause');
  resetCount = () => this.invoke('reset');

  /** Fire-and-forget: the room answers with a state broadcast. */
  increment = () => {
    this.log('increment_requested');
    void this.invoke('increment').catch((error) => this.log('increment_failed', { message: String(error) }));
  };

  close = () => {
    this.log('close_requested');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeSocket();
  };

  private async invoke(method: ActorMethod): Promise<CountCommandResult> {
    this.log('method_requested', { method });
    if (this.signal.aborted) return { status: 'cancelled' };
    await this.callActor(method, this.signal);
    return this.signal.aborted ? { status: 'cancelled' } : { status: 'ok' };
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
      case 'error': return this.failConnection(new Error(message.message));
      case 'state':
        this.onStateChanged?.(message.state, null);
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('counting-state-changed'));
        return;
      case 'state_changed':
        this.onStateChanged?.(message.state, message.speakerId);
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('counting-state-changed'));
        return;
    }
  }

  private failConnection(error: Error) {
    this.log('connection_failed', { message: error.message });
    this.closeSocket();
    // A live agent must not silently fall out of the count; rejoin while the voice session lives.
    if (!this.signal.aborted && this.onStateChanged && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, RECONNECT_DELAY_MS);
    }
  }

  private closeSocket() {
    const socket = this.socket;
    this.socket = null;
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

async function callCountingActor(method: ActorMethod, signal: AbortSignal) {
  const response = await fetch(`/api/counting/${method}`, {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error('The counting room is unavailable.');
}
