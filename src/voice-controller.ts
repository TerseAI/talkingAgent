import type { RealtimeItem, RealtimeSession } from '@openai/agents/realtime';
import { AGENT_MODEL, AGENT_REASONING_EFFORT, AGENT_VOICE, AGENT_INSTRUCTIONS } from '../shared/agent-config.mjs';
import { agentName, agentLabel } from '../shared/agent-identity.mjs';
import { CountingConnection } from './counting-connection';
import { CountingTurnDriver } from './counting-turns';
import { logVoiceEvent, logRealtimeEvent, observeAudioPlayback } from './voice-diagnostics';


export type TranscriptEntry = {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'event';
  timestamp?: string;
  title?: string;
  callId?: string;
  text: string;
  status: 'in_progress' | 'completed' | 'incomplete';
};
export type VoiceState = {
  status: 'idle' | 'connecting' | 'connected' | 'ended' | 'error';
  activity: 'listening' | 'thinking' | 'speaking';
  muted: boolean;
  /** True while another agent holds the counting turn and this mic is closed to it. */
  micGated: boolean;
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
  createCountingConnection?: (participantId: string, signal: AbortSignal) => CountingConnection;
  getToken: (signal: AbortSignal) => Promise<string>;
  createSession: (stream: MediaStream, audio: HTMLAudioElement, participantId: string, signal: AbortSignal, countingConnection?: CountingConnection, voice?: string) => Promise<RealtimeSession>;
};

const browserDependencies: Dependencies = {
  createCountingConnection: (participantId, signal) => new CountingConnection(participantId, signal),
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
  createSession: async (stream, audio, participantId, signal, countingConnection, voice = AGENT_VOICE) => {
    const { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC } = await import('@openai/agents/realtime');
    const { createCountingTools } = await import('./counting-tools');
    const agent = new RealtimeAgent({
      name: agentName(voice),
      instructions: AGENT_INSTRUCTIONS,
      tools: createCountingTools(countingConnection!),
    });
    return new RealtimeSession(agent, {
      model: AGENT_MODEL,
      transport: new OpenAIRealtimeWebRTC({ mediaStream: stream, audioElement: audio }),
      config: {
        reasoning: { effort: AGENT_REASONING_EFFORT },
        audio: {
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turnDetection: { type: 'semantic_vad', createResponse: true, interruptResponse: true },
          },
          output: { voice },
        },
      },
    });
  },
};

export class VoiceController {
  private state: VoiceState = {
    status: 'idle', activity: 'listening', muted: false, micGated: false, playbackBlocked: false,
    error: null, transcript: [],
  };
  private listeners = new Set<() => void>();
  private session: RealtimeSession | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private abort: AbortController | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private cleanups: (() => void)[] = [];
  private participantId: string | null = null;
  private countingConnection: CountingConnection | null = null;
  private turnDriver: CountingTurnDriver | null = null;

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

  private record(entry: TranscriptEntry) {
    const transcript = [...this.state.transcript];
    const index = transcript.findIndex((item) => item.id === entry.id);
    if (index < 0) transcript.push({ ...entry, timestamp: new Date().toISOString() });
    else transcript[index] = { ...transcript[index], ...entry };
    this.update({ transcript });
  }

  private release() {
    if (this.participantId) logVoiceEvent(this.participantId, 'session.release');
    this.update({ transcript: this.state.transcript.map((entry) =>
      entry.role === 'tool' && entry.status === 'in_progress'
        ? { ...entry, status: 'incomplete', text: `${entry.text}\nSession ended before a result was observed.` } : entry) });
    this.countingConnection?.close();
    this.countingConnection = null;
    this.turnDriver = null;
    this.abort?.abort();
    this.abort = null;
    this.participantId = null;
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
    logVoiceEvent(this.participantId, 'session.failed', { message: readableError(error) });
    this.release();
    this.update({ status: 'error', error: readableError(error), muted: false, micGated: false, playbackBlocked: false });
  }

  start = async (voice = AGENT_VOICE) => {
    if (this.state.status === 'connecting' || this.state.status === 'connected') return;
    this.release();
    const abort = new AbortController();
    const current = () => !abort.signal.aborted;
    this.abort = abort;
    this.update({ status: 'connecting', error: null, transcript: [], activity: 'listening', muted: false, micGated: false, playbackBlocked: false });
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
      const play = () => {
        logVoiceEvent(this.participantId, 'audio_element.play_requested');
        void audio.play().catch((error) => {
          if (current()) {
            logVoiceEvent(this.participantId, 'audio_element.play_rejected', { message: readableError(error) });
            this.update({ playbackBlocked: true });
          }
        });
      };
      audio.addEventListener('canplay', play);
      this.cleanups.push(() => audio.removeEventListener('canplay', play));
      this.participantId = `${agentName(voice)}:${crypto.randomUUID()}`;
      const participantId = this.participantId;
      logVoiceEvent(participantId, 'session.start', { voice, model: AGENT_MODEL });
      this.cleanups.push(observeAudioPlayback(participantId, audio));
      this.countingConnection = this.deps.createCountingConnection?.(this.participantId, abort.signal) ?? null;
      const session = await this.deps.createSession(stream, audio, this.participantId, abort.signal, this.countingConnection ?? undefined, voice);
      if (!current()) { session.close(); return; }
      this.session = session;
      this.turnDriver = this.createTurnDriver(participantId, session);

      const label = agentLabel(this.participantId);
      session.on('agent_tool_start', (_context, _agent, tool, details) => {
        if (!current()) return;
        const call = details.toolCall;
        const callId = 'callId' in call ? String(call.callId) : crypto.randomUUID();
        logVoiceEvent(participantId, 'tool.started', { tool: tool.name, callId, responseId: 'responseId' in call ? call.responseId : undefined });
        this.record({ id: `started:${callId}`, role: 'tool', callId,
          title: `${label} · ${tool.name} · Started`,
          text: 'arguments' in call ? String(call.arguments) : '{}', status: 'in_progress' });
      });
      session.on('agent_tool_end', (_context, _agent, tool, result, details) => {
        if (!current()) return;
        const callId = 'callId' in details.toolCall ? String(details.toolCall.callId) : crypto.randomUUID();
        logVoiceEvent(participantId, 'tool.returned', { tool: tool.name, callId, result });
        const started = this.state.transcript.find((entry) => entry.id === `started:${callId}`);
        if (started) this.record({ ...started, status: 'completed' });
        this.record({ id: `result:${callId}`, role: 'tool', callId,
          title: `${label} · ${tool.name} · Returned`, text: result, status: 'completed' });
      });
      session.on('history_updated', (history) => {
        if (current()) toTranscript(history).forEach((entry) => this.record(entry));
      });
      session.on('audio_start', () => { if (current()) { logVoiceEvent(participantId, 'session.audio_start'); this.update({ activity: 'speaking' }); } });
      session.on('audio_stopped', () => { if (current()) { logVoiceEvent(participantId, 'session.audio_stopped'); this.update({ activity: 'listening' }); } });
      session.on('audio_interrupted', () => { if (current()) { logVoiceEvent(participantId, 'session.audio_interrupted'); this.update({ activity: 'listening' }); } });
      session.on('transport_event', (event) => {
        if (!current()) return;
        logRealtimeEvent(participantId, event, audio);
        this.turnDriver?.onTransportEvent(event as { type: string });
        if (event.type === 'response.output_item.added') {
          const item = event.item as { type?: string; id?: string; call_id?: string; name?: string; arguments?: string; role?: string };
          if (item.type === 'function_call') {
            this.record({ id: `generated:${item.call_id}`, role: 'tool', callId: item.call_id,
              title: `${label} · ${item.name} · Generated`, text: item.arguments || '(Generating arguments)', status: 'completed' });
          } else if (item.type === 'message' && item.role === 'assistant' && item.id) {
            this.record({ id: item.id, role: 'assistant', text: '', status: 'in_progress' });
          }
        }
        if (event.type === 'response.function_call_arguments.done') {
          const entry = this.state.transcript.find((item) => item.id === `generated:${event.call_id}`);
          if (entry) this.record({ ...entry, text: String(event.arguments) });
        }
        if (['output_audio_buffer.started', 'output_audio_buffer.stopped', 'output_audio_buffer.cleared', 'response.done'].includes(event.type)) {
          const response = ('response' in event ? event.response : undefined) as { id?: string; status?: string } | undefined;
          this.record({ id: `event:${crypto.randomUUID()}`, role: 'event',
            title: `${label} · ${event.type}`, text: [('response_id' in event ? event.response_id : undefined) ?? response?.id, response?.status].filter(Boolean).join(' · '), status: 'completed' });
        }
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
        if (current()) logVoiceEvent(participantId, 'session.connection_changed', { status });
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
      logVoiceEvent(participantId, 'session.connected');
      this.countingConnection?.connect();
    } catch (error) {
      if (current()) this.fail(error);
    }
  };

  private createTurnDriver(participantId: string, session: RealtimeSession) {
    const connection = this.countingConnection;
    if (!connection) return null;
    const driver = new CountingTurnDriver(participantId, {
      requestResponse: (instructions, turnId) => session.transport.sendEvent({ type: 'response.create', response: { instructions, metadata: { turnId } } }),
      completeTurn: connection.completeTurn,
      pauseCount: () => { connection.pauseCount().catch(() => {}); },
      setListening: (listening) => {
        if (this.state.micGated !== !listening) { this.update({ micGated: !listening }); this.applyMute(); }
      },
    }, (event, details) => logVoiceEvent(participantId, event, details));
    connection.onStateChanged = (state, turnId) => { if (this.session === session) driver.onState(state, turnId); };
    return driver;
  }

  private applyMute() {
    this.session?.mute(this.state.muted || this.state.micGated);
  }

  stop = () => {
    this.release();
    this.update({ status: 'ended', muted: false, micGated: false, playbackBlocked: false });
  };
  toggleMute = () => {
    if (this.state.status !== 'connected' || !this.session) return;
    const muted = !this.state.muted;
    logVoiceEvent(this.participantId, 'microphone.mute_requested', { muted });
    this.update({ muted });
    this.applyMute();
  };
  interrupt = () => {
    if (this.state.status !== 'connected') return;
    logVoiceEvent(this.participantId, 'session.interrupt_requested');
    this.session?.interrupt();
    this.update({ activity: 'listening' });
  };
  send = (text: string) => {
    if (!text.trim() || this.state.status !== 'connected' || !this.session) return;
    logVoiceEvent(this.participantId, 'user.text_sent', { text: text.trim() });
    try {
      this.session.sendMessage(text.trim());
      this.update({ activity: 'thinking' });
    } catch (error) { this.fail(error); }
  };
  enablePlayback = async () => {
    const audio = this.audio;
    logVoiceEvent(this.participantId, 'audio_element.enable_requested');
    try {
      await audio?.play();
      if (audio && audio === this.audio) this.update({ playbackBlocked: false });
    } catch (error) {
      logVoiceEvent(this.participantId, 'audio_element.enable_rejected', { message: readableError(error) });
    }
  };
  dispose = () => { this.release(); };
}
