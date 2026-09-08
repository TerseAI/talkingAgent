import { countingEventSchema } from '../shared/counting-protocol.mjs';
import type { TurnGrantResult, TurnCompletionResult, CountResetResult } from './counting-api';

type CountingEvent = ReturnType<typeof countingEventSchema.parse>;
type CountingSocket = Pick<WebSocket, 'send' | 'close' | 'addEventListener'>;
type CommandResult = TurnGrantResult | TurnCompletionResult | CountResetResult;
type PendingCommand = {
  type: 'request_turn' | 'report_turn_complete' | 'reset_count';
  requestId: string;
  promise: Promise<CommandResult>;
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
};

export class CountingConnection {
  private socket: CountingSocket | null = null;
  private actorReady = false;
  private pendingCommand: PendingCommand | null = null;
  private activeTurnId: string | null = null;

  constructor(private participantId: string, private signal: AbortSignal, private openSocket = openCountingSocket) {
    signal.addEventListener('abort', this.close, { once: true });
  }

  waitForTurn = (): Promise<TurnGrantResult> => this.sendCommand('request_turn', this.activeTurnId ?? crypto.randomUUID());

  reportTurnComplete = (): Promise<TurnCompletionResult> => {
    if (this.signal.aborted) return Promise.resolve({ status: 'cancelled' });
    if (!this.activeTurnId) return Promise.reject(new Error('Call wait_for_turn and speak the assigned number before report_turn_complete.'));
    return this.sendCommand('report_turn_complete', this.activeTurnId);
  };

  resetCount = (): Promise<CountResetResult> => this.sendCommand('reset_count', crypto.randomUUID());

  close = () => {
    this.resolvePendingCommand({ status: 'cancelled' });
    this.closeSocket();
  };

  private sendCommand(type: 'request_turn', requestId: string): Promise<TurnGrantResult>;
  private sendCommand(type: 'report_turn_complete', requestId: string): Promise<TurnCompletionResult>;
  private sendCommand(type: 'reset_count', requestId: string): Promise<CountResetResult>;
  private sendCommand(type: PendingCommand['type'], requestId: string): Promise<CommandResult> {
    if (this.signal.aborted) return Promise.resolve({ status: 'cancelled' });
    if (this.pendingCommand) return this.pendingCommand.type === type
      ? this.pendingCommand.promise : Promise.reject(new Error('Wait for the pending counting command to finish.'));
    let resolve!: PendingCommand['resolve'];
    let reject!: PendingCommand['reject'];
    const promise = new Promise<CommandResult>((yes, no) => { resolve = yes; reject = no; });
    this.pendingCommand = { type, requestId, promise, resolve, reject };
    try {
      if (!this.socket) this.connectSocket();
      if (this.actorReady) this.sendPendingCommand();
    } catch (error) { this.failConnection(error instanceof Error ? error : new Error(String(error))); }
    return promise;
  }

  private connectSocket() {
    const socket = this.openSocket(this.participantId);
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.onMessage(String(event.data));
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.failConnection(new Error('The counting connection closed. Request a new turn to reconnect.'));
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) this.failConnection(new Error('Could not connect to the counting room. Check that the actor runtime is running.'));
    });
  }

  private onMessage(data: string) {
    let message;
    try { message = countingEventSchema.parse(JSON.parse(data)); }
    catch { this.failConnection(new Error('The counting room sent an invalid socket message.')); return; }
    switch (message.type) {
      case 'ready': if (!this.actorReady) { this.actorReady = true; this.sendPendingCommand(); } return;
      case 'error': return this.failConnection(new Error(message.message));
      case 'count_reset': return this.onCountReset(message);
      case 'turn_completed': return this.onTurnCompleted(message.requestId);
      case 'turn_changed': return this.onTurnChanged(message);
    }
  }

  private onCountReset(message: Extract<CountingEvent, { type: 'count_reset' }>) {
    this.activeTurnId = null;
    if (this.pendingCommand?.type === 'reset_count') {
      if (message.requestId === this.pendingCommand.requestId) this.resolvePendingCommand({ status: 'reset' });
    } else this.resolvePendingCommand({ status: 'cancelled' });
    this.notifyCountChanged();
  }

  private onTurnCompleted(requestId: string) {
    if (this.pendingCommand?.type !== 'report_turn_complete' || requestId !== this.pendingCommand.requestId) return;
    this.activeTurnId = null;
    this.resolvePendingCommand({ status: 'completed' });
  }

  private onTurnChanged(message: Extract<CountingEvent, { type: 'turn_changed' }>) {
    if (this.pendingCommand?.type === 'request_turn') {
      if (message.state.finished) this.resolvePendingCommand({ status: 'finished', completedCount: 100, targetCount: 100 });
      else if (message.state.currentSpeakerId === this.participantId && message.turnRequestId === this.pendingCommand.requestId) {
        this.activeTurnId = message.turnRequestId;
        this.resolvePendingCommand({ status: 'granted', completedCount: message.state.completedCount, numberToSpeak: message.state.nextNumber, targetCount: 100 });
      }
    }
    this.notifyCountChanged();
  }

  private sendPendingCommand() {
    if (!this.pendingCommand) return;
    try { this.socket!.send(JSON.stringify({ type: this.pendingCommand.type, requestId: this.pendingCommand.requestId })); }
    catch { this.failConnection(new Error('Could not send the counting command.')); }
  }

  private resolvePendingCommand(result: CommandResult) {
    const pendingCommand = this.pendingCommand;
    this.pendingCommand = null;
    pendingCommand?.resolve(result);
  }

  private failConnection(error: Error) {
    const pendingCommand = this.pendingCommand;
    this.pendingCommand = null;
    this.closeSocket();
    pendingCommand?.reject(error);
  }

  private closeSocket() {
    const socket = this.socket;
    this.socket = null;
    this.actorReady = false;
    this.activeTurnId = null;
    socket?.close();
  }

  private notifyCountChanged() {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('counting-state-changed'));
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

function openCountingSocket(participantId: string): CountingSocket {
  const url = new URL('/api/counting/socket', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('participantId', participantId);
  return new WebSocket(url);
}
