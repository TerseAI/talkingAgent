import { counterRequest, type CountResult, type CounterSnapshot } from './counter-api';

export type CountingState = {
  clientId: string; phase: 'waiting' | 'speaking' | 'finishing' | 'done' | 'blocked';
  number: number | null;
};
type CountEvent = {
  type: string; response_id?: string; transcript?: string;
  response?: { id?: string; status?: string; metadata?: Record<string, string>; output?: { content?: { transcript?: string; text?: string }[] }[] };
};
type Dependencies = {
  request: typeof counterRequest;
  requestResponse: (options: Record<string, unknown>) => void;
  setOutputEnabled: (enabled: boolean) => void;
  canConfirmPlayback: () => boolean;
  onState: (state: CountingState) => void;
  onError: (message: string) => void;
  onDone: () => void;
};

export class CountingCoordinator {
  private state: CountingState;
  private abort = new AbortController();
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private speech: { id?: string; transcript?: string; played: boolean } | null = null;

  constructor(private deps: Dependencies, clientId = crypto.randomUUID()) {
    this.state = { clientId, phase: 'waiting', number: null };
  }

  start() {
    if (!this.abort.signal.aborted) this.requestTurn();
  }

  async claimTool() {
    if (this.abort.signal.aborted || this.state.number !== null) return { status: 'stopped' };
    this.clearTimers();
    try {
      while (!this.abort.signal.aborted) {
        const result = await this.deps.request<CountResult>('claim', { clientId: this.state.clientId }, this.abort.signal);
        if (this.abort.signal.aborted) return { status: 'stopped' };
        if (result.status === 'waiting') {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        if (result.status === 'done') {
          this.done();
          return result;
        }
        this.update({ number: result.next_number });
        return result;
      }
    } catch (error) { if (!this.abort.signal.aborted) this.fail(error); }
    return { status: 'stopped' };
  }

  toolFinished() {
    if (this.abort.signal.aborted || this.state.number === null || this.state.phase !== 'waiting') return;
    this.speech = { played: false };
    this.update({ phase: 'speaking' });
    this.deps.setOutputEnabled(true);
    this.deadline = setTimeout(() => this.fail(new Error('This number did not finish playing. The agent has stopped.')), 45_000);
    this.deps.requestResponse({
      output_modalities: ['audio'], tool_choice: 'none',
      metadata: { count_number: String(this.state.number) },
      instructions: `Say exactly "${numberWords(this.state.number)}" once, with no other words. Then remain silent.`,
    });
  }

  receive(event: CountEvent) {
    const speech = this.speech;
    if (this.abort.signal.aborted || !speech) return;
    if (event.type === 'response.created' && event.response?.metadata?.count_number === String(this.state.number)) {
      speech.id = event.response.id;
    }
    const responseId = event.response_id ?? event.response?.id;
    if (!speech.id || responseId !== speech.id) return;
    if (event.type === 'output_audio_buffer.stopped') speech.played = true;
    if (event.type === 'output_audio_buffer.cleared') { this.fail(new Error('The number was interrupted and was not counted.')); return; }
    if (event.type === 'response.done') {
      if (event.response?.status !== 'completed') { this.fail(new Error('The counting response did not complete.')); return; }
      speech.transcript = event.response.output?.flatMap((item) => item.content?.map((part) => part.transcript ?? part.text ?? '') ?? []).join(' ').trim() ?? '';
    }
    if (speech.transcript !== undefined && speech.played && this.state.phase === 'speaking') void this.finishTurn(speech.transcript);
  }

  stop() {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    this.clearTimers();
    this.deps.setOutputEnabled(false);
    void this.deps.request('cancel', { clientId: this.state.clientId }).catch(() => {});
  }

  private requestTurn() {
    this.deps.setOutputEnabled(false);
    this.update({ phase: 'waiting', number: null });
    this.deadline = setTimeout(() => this.fail(new Error('The model did not call the counter tool. Start a new agent.')), 30_000);
    this.deps.requestResponse({
      output_modalities: ['text'], tool_choice: { type: 'function', name: 'get_latest_count' },
      instructions: 'Call get_latest_count with no arguments to wait for your next turn. Do not produce a spoken or written answer.',
    });
  }

  private async finishTurn(transcript: string) {
    const number = this.state.number!;
    if (!isExpectedNumber(transcript, number)) {
      this.fail(new Error(`Expected only ${number}, but heard “${transcript || 'no transcript'}”. The agent has stopped.`));
      return;
    }
    if (!this.deps.canConfirmPlayback()) { this.fail(new Error('Audio playback was blocked or muted. The count was not advanced.')); return; }
    this.update({ phase: 'finishing' });
    // The SDK audio_stopped event means generation finished. Use the WebRTC playback-buffer
    // stopped event above, plus a short output-tail allowance, before releasing the turn.
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (this.abort.signal.aborted) return;
    if (!this.deps.canConfirmPlayback()) { this.fail(new Error('Audio playback stopped before the turn could be confirmed.')); return; }
    try {
      const result = await this.deps.request<CounterSnapshot>('complete', { clientId: this.state.clientId, number }, this.abort.signal);
      if (this.abort.signal.aborted) return;
      this.speech = null;
      this.clearTimers();
      if (result.done) this.done(); else this.requestTurn();
    } catch (error) { if (!this.abort.signal.aborted) this.fail(error); }
  }

  private done() { this.update({ phase: 'done', number: null }); this.stop(); this.deps.onDone(); }
  private fail(error: unknown) {
    if (this.abort.signal.aborted) return;
    const message = error instanceof Error ? error.message : 'The counter session failed.';
    this.update({ phase: 'blocked' });
    this.stop();
    this.deps.onError(message);
  }
  private clearTimers() {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }
  private update(patch: Partial<CountingState>) { this.state = { ...this.state, ...patch }; this.deps.onState(this.state); }
}

export function numberWords(number: number): string {
  const small = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  if (number < 20) return small[number];
  if (number === 100) return 'one hundred';
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  return `${tens[Math.floor(number / 10)]}${number % 10 ? ` ${small[number % 10]}` : ''}`;
}
export function isExpectedNumber(text: string, number: number): boolean {
  const normalized = text.toLowerCase().replace(/[.!?,]/g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized === String(number) || normalized === numberWords(number);
}
