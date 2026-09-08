import type { RealtimeItem, RealtimeSession } from '@openai/agents/realtime';
import { AGENT_NAME, AGENT_MODEL, AGENT_VOICE, AGENT_INSTRUCTIONS } from '../shared/agent-config.mjs';
import { counterRequest } from './counter-api';
import { CounterLock } from './counter-lock';


export type TranscriptEntry = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status: 'in_progress' | 'completed' | 'incomplete';
};
export type VoiceState = {
  status: 'idle' | 'connecting' | 'connected' | 'ended' | 'error';
  activity: 'listening' | 'thinking' | 'speaking';
  muted: boolean;
  playbackBlocked: boolean;
  error: string | null;
  transcript: TranscriptEntry[];
};

export function toTranscript(history: RealtimeItem[]): TranscriptEntry[] {
  return history.flatMap((item) => {
    if (item.type !== 'message' || item.role === 'system') return [];
    const text = item.content.map((part) => 'text' in part ? part.text : part.transcript ?? '').join('\n').trim();
    return [{ id: item.itemId, role: item.role, text, status: item.status }];
  });
}

function readableError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Microphone access was denied. Allow it in your browser’s site settings, then try again.';
    if (error.name === 'NotFoundError') return 'No microphone was found. Connect a microphone and try again.';
    if (error.name === 'NotReadableError') return 'Your microphone is unavailable. Check whether another app is using it, then try again.';
  }
  if (error instanceof Error) return error.message;
  return 'The voice connection encountered a problem. Please start a new conversation.';
}

type Dependencies = {
  getMedia: () => Promise<MediaStream>;
  createAudio: () => HTMLAudioElement;
  createLock?: (clientId: string, signal: AbortSignal) => CounterLock;
  getToken: (signal: AbortSignal) => Promise<string>;
  createSession: (stream: MediaStream, audio: HTMLAudioElement, clientId: string, signal: AbortSignal, lock?: CounterLock) => Promise<RealtimeSession>;
};

const browserDependencies: Dependencies = {
  createLock: (clientId, signal) => new CounterLock(clientId, signal, new EventSource(`/api/counter/events?clientId=${encodeURIComponent(clientId)}`)),
  getMedia: () => {
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access requires localhost or an HTTPS connection in a supported browser.');
    }
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  },
  createAudio: () => {
    const audio = new Audio();
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    return audio;
  },
  getToken: async (signal) => {
    const response = await fetch('/api/session', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || 'The server could not start a session. Please try again.');
    if (typeof data?.value !== 'string' || !data.value.startsWith('ek_')) {
      throw new Error('The server returned an invalid session credential. Please try again.');
    }
    return data.value;
  },
  createSession: async (stream, audio, clientId, signal, lock) => {
    const { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC } = await import('@openai/agents/realtime');
    const { createCounterTools } = await import('./counter-tools');
    const agent = new RealtimeAgent({
      name: AGENT_NAME,
      instructions: AGENT_INSTRUCTIONS,
      tools: createCounterTools(clientId, signal, lock!.claim, counterRequest, lock!.cancel),
    });
    return new RealtimeSession(agent, {
      model: AGENT_MODEL,
      transport: new OpenAIRealtimeWebRTC({ mediaStream: stream, audioElement: audio }),
      config: {
        audio: {
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turnDetection: { type: 'semantic_vad', createResponse: true, interruptResponse: true },
          },
          output: { voice: AGENT_VOICE },
        },
      },
    });
  },
};

export class VoiceController {
  private state: VoiceState = {
    status: 'idle', activity: 'listening', muted: false, playbackBlocked: false,
    error: null, transcript: [],
  };
  private listeners = new Set<() => void>();
  private session: RealtimeSession | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private abort: AbortController | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private cleanups: (() => void)[] = [];
  private clientId: string | null = null;
  private lock: CounterLock | null = null;

  constructor(private deps: Dependencies = browserDependencies) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private release() {
    this.lock?.cancel();
    this.lock = null;
    this.abort?.abort();
    this.abort = null;
    if (this.clientId) void counterRequest('cancel', { clientId: this.clientId }).catch(() => {});
    this.clientId = null;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    const session = this.session;
    this.session = null;
    try { session?.close(); } finally {
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      if (this.audio) {
        this.audio.pause();
        this.audio.srcObject = null;
        this.audio = null;
      }
    }
  }

  private fail(error: unknown) {
    this.release();
    this.update({ status: 'error', error: readableError(error), muted: false, playbackBlocked: false });
  }

  start = async () => {
    if (this.state.status === 'connecting' || this.state.status === 'connected') return;
    this.release();
    const abort = new AbortController();
    const current = () => !abort.signal.aborted;
    this.abort = abort;
    this.update({ status: 'connecting', error: null, transcript: [], activity: 'listening', muted: false, playbackBlocked: false });
    this.timeout = setTimeout(() => {
      if (current()) this.fail(new Error('The connection timed out. Check microphone permission and your internet connection, then try again.'));
    }, 30_000);

    try {
      const stream = await this.deps.getMedia();
      if (!current()) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      // Keep the mic off while minting credentials and negotiating the connection.
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
        const ended = () => { if (current()) this.fail(new Error('Your microphone disconnected. Reconnect it and start a new conversation.')); };
        track.addEventListener('ended', ended);
        this.cleanups.push(() => track.removeEventListener('ended', ended));
      });
      const token = await this.deps.getToken(abort.signal);
      if (!current()) return;
      const audio = this.deps.createAudio();
      this.audio = audio;
      const play = () => { void audio.play().catch(() => { if (current()) this.update({ playbackBlocked: true }); }); };
      audio.addEventListener('canplay', play);
      this.cleanups.push(() => audio.removeEventListener('canplay', play));
      this.clientId = crypto.randomUUID();
      this.lock = this.deps.createLock?.(this.clientId, abort.signal) ?? null;
      const session = await this.deps.createSession(stream, audio, this.clientId, abort.signal, this.lock ?? undefined);
      if (!current()) { session.close(); return; }
      this.session = session;

      session.on('history_updated', (history) => { if (current()) this.update({ transcript: toTranscript(history) }); });
      session.on('audio_start', () => { if (current()) this.update({ activity: 'speaking' }); });
      session.on('audio_stopped', () => { if (current()) this.update({ activity: 'listening' }); });
      session.on('audio_interrupted', () => { if (current()) this.update({ activity: 'listening' }); });
      session.on('transport_event', (event) => {
        if (!current()) return;
        if (event.type === 'input_audio_buffer.speech_started') {
          this.update({ activity: 'listening' });
        }
        if (event.type === 'input_audio_buffer.speech_stopped' || event.type === 'response.created') this.update({ activity: 'thinking' });
        if (event.type === 'response.done') {
          const response = event.response as { status?: string } | undefined;
          if (response?.status === 'failed') this.fail(new Error('OpenAI could not complete the response. Check your API usage limits and try a new conversation.'));
        }
      });
      session.on('error', () => {
        if (current()) this.fail(new Error('OpenAI reported a session error. Check your API access and usage limits, then start a new conversation.'));
      });
      const connectionChanged = (status: string) => {
        if (current() && status === 'disconnected') this.fail(new Error('The voice connection closed. Check your internet connection and start a new conversation.'));
      };
      session.transport.on('connection_change', connectionChanged);
      this.cleanups.push(() => {
        session.transport.off('connection_change', connectionChanged);
        session.removeAllListeners();
      });

      await session.connect({ apiKey: token });
      if (!current()) { session.close(); return; }
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = null;
      stream.getAudioTracks().forEach((track) => { track.enabled = true; });
      this.update({ status: 'connected' });
    } catch (error) {
      if (current()) this.fail(error);
    }
  };

  private cancelTurn() {
    this.lock?.cancel();
    if (this.clientId) void counterRequest('cancel', { clientId: this.clientId }).catch(() => {});
  }

  stop = () => {
    this.release();
    this.update({ status: 'ended', muted: false, playbackBlocked: false });
  };
  toggleMute = () => {
    if (this.state.status !== 'connected' || !this.session) return;
    const muted = !this.state.muted;
    this.session.mute(muted);
    this.update({ muted });
  };
  interrupt = () => {
    if (this.state.status !== 'connected') return;
    this.cancelTurn();
    this.session?.interrupt();
    this.update({ activity: 'listening' });
  };
  send = (text: string) => {
    if (!text.trim() || this.state.status !== 'connected' || !this.session) return;
    try {
      this.session.sendMessage(text.trim());
      this.update({ activity: 'thinking' });
    } catch (error) { this.fail(error); }
  };
  enablePlayback = async () => {
    const audio = this.audio;
    try {
      await audio?.play();
      if (audio && audio === this.audio) this.update({ playbackBlocked: false });
    } catch { /* Keep the enable-audio button available for another user gesture. */ }
  };
  dispose = () => { this.release(); };
}
