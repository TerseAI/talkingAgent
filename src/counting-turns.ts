import type { CountingSnapshot } from './counting-api';

export type TurnSpeaker = {
  requestResponse(instructions: string, turnId: string): void;
  completeTurn(turnId: string): void;
  pauseCount(): void;
  setListening(listening: boolean): void;
};
type TransportEvent = { type: string; response?: { id?: string; metadata?: { turnId?: string }; output?: { type?: string }[] }; response_id?: string };
type ActiveTurn = { turnId: string; number: number; responseId: string | null; queued: boolean; attempts: number; pauseRequested: boolean };

const MAX_ATTEMPTS = 2;

/**
 * Drives one participant through the shared count: cues the model when the room assigns a
 * number, reports the turn complete once playback stops, keeps the mic closed while others speak,
 * and pauses the room when the user starts talking to the current speaker.
 */
export class CountingTurnDriver {
  private turn: ActiveTurn | null = null;
  private responseActive = false;

  constructor(private participantId: string, private speaker: TurnSpeaker, private log: (event: string, details?: Record<string, unknown>) => void = () => {}) {}

  onState(state: CountingSnapshot, turnId: string | null) {
    const mine = state.counting && state.currentSpeakerId === this.participantId && turnId !== null;
    this.speaker.setListening(!state.counting || mine);
    if (!mine) { this.turn = null; return; }
    if (this.turn?.turnId === turnId) return;
    this.turn = { turnId, number: state.nextNumber, responseId: null, queued: false, attempts: 0, pauseRequested: false };
    this.cue();
  }

  onTransportEvent(event: TransportEvent) {
    switch (event.type) {
      case 'response.created': return this.onResponseCreated(event.response);
      case 'response.done': return this.onResponseDone(event.response);
      case 'output_audio_buffer.stopped': return this.onPlaybackStopped(event.response_id ?? null);
      case 'input_audio_buffer.speech_started': return this.onUserSpeech();
    }
  }

  private cue() {
    const turn = this.turn;
    if (!turn) return;
    if (this.responseActive) { turn.queued = true; this.log('turn.cue_queued', { turnId: turn.turnId }); return; }
    turn.attempts += 1;
    this.log('turn.cued', { turnId: turn.turnId, number: turn.number, attempt: turn.attempts });
    this.speaker.requestResponse(spokenNumberInstructions(turn.number), turn.turnId);
  }

  // The API queues response.create calls, so the SDK's own post-tool response can arrive first.
  // Only a response carrying this turn's metadata belongs to the cue.
  private onResponseCreated(response: TransportEvent['response']) {
    this.responseActive = true;
    if (this.turn && response?.metadata?.turnId === this.turn.turnId) this.turn.responseId = response.id ?? null;
  }

  private onResponseDone(response: TransportEvent['response']) {
    this.responseActive = false;
    const turn = this.turn;
    if (!turn) return;
    if (turn.queued) { turn.queued = false; this.cue(); return; }
    const spoke = response?.output?.some((item) => item.type === 'message') ?? false;
    if (turn.responseId !== null && response?.id === turn.responseId && !spoke && turn.attempts < MAX_ATTEMPTS) {
      this.log('turn.no_speech_retry', { turnId: turn.turnId, responseId: response?.id });
      this.cue();
    }
  }

  private onUserSpeech() {
    const turn = this.turn;
    if (!turn || turn.pauseRequested) return;
    turn.pauseRequested = true;
    this.log('turn.paused_for_user', { turnId: turn.turnId, number: turn.number });
    this.speaker.pauseCount();
  }

  private onPlaybackStopped(responseId: string | null) {
    const turn = this.turn;
    if (!turn || turn.responseId === null || responseId !== turn.responseId) return;
    this.log('turn.playback_finished', { turnId: turn.turnId, number: turn.number });
    this.turn = null;
    this.speaker.completeTurn(turn.turnId);
  }
}

function spokenNumberInstructions(number: number) {
  return `You are taking part in a shared group count. It is your turn now. Say only the number ${number}, spoken as words, and nothing else. Do not call any tool.`;
}
