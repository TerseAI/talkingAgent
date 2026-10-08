import type { CountingState } from './counting-api';

export type TurnSpeaker = {
  requestResponse(instructions: string, number: number): void;
  increment(): void;
  pauseCount(): void;
  setListening(listening: boolean): void;
};
type TransportEvent = { type: string; response?: { id?: string; metadata?: { number?: string }; output?: { type?: string }[] }; response_id?: string };
type ActiveTurn = { number: number; responseId: string | null; queued: boolean; attempts: number; pauseRequested: boolean; spoken: boolean };

const MAX_ATTEMPTS = 2;

/**
 * Drives one participant through the shared count: cues the model when the count selects it,
 * increments once playback stops, keeps the mic closed while others speak,
 * and pauses the room when the user starts talking to the current speaker.
 */
export class CountingTurnDriver {
  private turn: ActiveTurn | null = null;
  private responseActive = false;

  constructor(private participantId: string, private speaker: TurnSpeaker, private log: (event: string, details?: Record<string, unknown>) => void = () => {}) {}

  onState(state: CountingState, speakerId: string | null) {
    const nextNumber = state.count + 1;
    const mine = state.running && speakerId === this.participantId;
    this.speaker.setListening(!state.running || mine);
    if (!mine) { this.turn = null; return; }
    if (this.turn?.number === nextNumber) return;
    this.turn = { number: nextNumber, responseId: null, queued: false, attempts: 0, pauseRequested: false, spoken: false };
    this.cue();
  }

  onTransportEvent(event: TransportEvent) {
    switch (event.type) {
      case 'response.created': return this.onResponseCreated(event.response);
      case 'response.done': return this.onResponseDone(event.response);
      case 'output_audio_buffer.stopped': return this.onPlaybackStopped();
      case 'input_audio_buffer.speech_started': return this.onUserSpeech();
    }
  }

  private cue() {
    const turn = this.turn;
    if (!turn) return;
    if (this.responseActive) { turn.queued = true; this.log('turn.cue_queued', { number: turn.number }); return; }
    turn.attempts += 1;
    this.log('turn.cued', { number: turn.number, attempt: turn.attempts });
    this.speaker.requestResponse(spokenNumberInstructions(turn.number), turn.number);
  }

  // The API queues response.create calls, so the SDK's own post-tool response can arrive first.
  // Only a response carrying this turn's metadata belongs to the cue.
  private onResponseCreated(response: TransportEvent['response']) {
    this.responseActive = true;
    if (this.turn && response?.metadata?.number === String(this.turn.number)) this.turn.responseId = response.id ?? null;
  }

  private onResponseDone(response: TransportEvent['response']) {
    this.responseActive = false;
    const turn = this.turn;
    if (!turn) return;
    if (turn.queued) { turn.queued = false; this.cue(); return; }
    const spoke = response?.output?.some((item) => item.type === 'message') ?? false;
    if (turn.responseId === null || response?.id !== turn.responseId) return;
    if (spoke) { turn.spoken = true; return; }
    if (turn.attempts < MAX_ATTEMPTS) {
      this.log('turn.no_speech_retry', { number: turn.number, responseId: response?.id });
      this.cue();
    }
  }

  private onUserSpeech() {
    const turn = this.turn;
    if (!turn || turn.pauseRequested) return;
    turn.pauseRequested = true;
    this.log('turn.paused_for_user', { number: turn.number });
    this.speaker.pauseCount();
  }

  private onPlaybackStopped() {
    const turn = this.turn;
    if (!turn?.spoken) return;
    this.log('turn.playback_finished', { number: turn.number });
    this.turn = null;
    this.speaker.increment();
  }
}

function spokenNumberInstructions(number: number) {
  return `You are taking part in a shared group count. It is your turn now. Say only the number ${number}, spoken as words, and nothing else. Do not call any tool.`;
}
