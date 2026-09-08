import type { MediaStream, RTCPeerConnection } from 'react-native-webrtc';
import { applyEvent, type Entry, type RealtimeEvent } from './transcript';

export type SessionOptions = { apiUrl: string; instance: number; mode: 'assistant' | 'group-counting' };
export type SessionState = {
  status: 'idle' | 'connecting' | 'connected' | 'ended' | 'error';
  activity: 'listening' | 'thinking' | 'speaking';
  transcript: Entry[]; muted: boolean; speaker: boolean; error: string | null;
  startedAt: number | null; endedAt: number | null;
};
export type NativeDependencies = {
  getMedia: () => Promise<MediaStream>;
  createPeer: () => RTCPeerConnection;
  startAudio: () => void; stopAudio: () => void; setSpeaker: (speaker: boolean) => void;
  fetch: typeof fetch;
};

export class NativeVoiceSession {
  private state: SessionState = { status: 'idle', activity: 'listening', transcript: [], muted: false, speaker: true, error: null, startedAt: null, endedAt: null };
  private listeners = new Set<() => void>();
  private generation = 0;
  private stream: MediaStream | null = null;
  private peer: RTCPeerConnection | null = null;
  private channel: ReturnType<RTCPeerConnection['createDataChannel']> | null = null;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cleanups: (() => void)[] = [];
  private audioStarted = false;
  private responsePending = false;
  private playing = false;

  constructor(private deps: NativeDependencies) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<SessionState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }

  private release() {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    const resources = [
      () => this.channel?.close(), () => this.peer?.close(),
      () => this.stream?.getTracks().forEach((track) => track.stop()),
      () => this.stream?.release(),
      () => { if (this.audioStarted) this.deps.stopAudio(); },
    ];
    resources.forEach((cleanup) => { try { cleanup(); } catch { /* Already closed. */ } });
    this.channel = null; this.peer = null; this.stream = null;
    this.audioStarted = false; this.playing = false; this.responsePending = false;
  }

  private fail(error: unknown) {
    this.release();
    const name = (error as { name?: string })?.name;
    const message = name === 'NotAllowedError' || name === 'SecurityError'
      ? 'Microphone permission was denied. Enable it in Settings, then try again.'
      : name === 'NotFoundError' ? 'No microphone is available. Use a physical phone or check the simulator’s audio input.'
      : error instanceof Error ? error.message : 'The voice session failed. Please try again.';
    this.update({ status: 'error', error: message, muted: false, endedAt: Date.now() });
  }

  start = async (options: SessionOptions) => {
    if (['connecting', 'connected'].includes(this.state.status)) return;
    this.release();
    const generation = this.generation;
    const current = () => generation === this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.update({ status: 'connecting', activity: 'listening', transcript: [], muted: false, error: null, startedAt: null, endedAt: null });
    this.timer = setTimeout(() => { if (current()) this.fail(new Error('Connection timed out. Check the server address, microphone permission, and network.')); }, 30_000);

    try {
      const url = new URL(options.apiUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter an HTTP or HTTPS server address without credentials.');
      const stream = await this.deps.getMedia();
      if (!current()) { stream.getTracks().forEach((track) => track.stop()); stream.release(); return; }
      this.stream = stream;
      stream.getAudioTracks().forEach((track) => { track.enabled = false; });
      const tokenResponse = await this.deps.fetch(`${url.origin}/api/session`, {
        method: 'POST',
        // Native fetch can set Origin. The server retains its browser origin checks.
        headers: { 'Content-Type': 'application/json', Origin: url.origin },
        body: JSON.stringify({ instance: options.instance, mode: options.mode }), signal: abort.signal,
      });
      const token = await tokenResponse.json().catch(() => null);
      if (!current()) return;
      if (!tokenResponse.ok) throw new Error(token?.error ?? 'Could not create a session. Check the server’s API key.');
      if (typeof token?.value !== 'string' || !token.value.startsWith('ek_')) throw new Error('The server returned an invalid session credential.');
      this.audioStarted = true;
      this.deps.startAudio();
      this.deps.setSpeaker(this.state.speaker);
      const peer = this.deps.createPeer();
      this.peer = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      const channel = peer.createDataChannel('oai-events');
      this.channel = channel;

      const onMessage = (message: { data: string | ArrayBuffer }) => {
        if (!current() || typeof message.data !== 'string') return;
        let event: RealtimeEvent;
        try { event = JSON.parse(message.data); } catch { return; }
        if (event.type === 'session.created') {
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
          stream.getAudioTracks().forEach((track) => { track.enabled = true; });
          this.update({ status: 'connected', startedAt: Date.now() });
        }
        if (event.type === 'error') {
          if (event.error?.code === 'response_cancel_not_active') return;
          this.fail(new Error(event.error?.message ?? 'OpenAI reported a session error.')); return;
        }
        if (event.type === 'response.created') { this.responsePending = true; this.update({ activity: 'thinking' }); }
        if (event.type === 'output_audio_buffer.started') { this.playing = true; this.update({ activity: 'speaking' }); }
        if (['output_audio_buffer.stopped', 'output_audio_buffer.cleared'].includes(event.type)) { this.playing = false; this.update({ activity: 'listening' }); }
        if (event.type === 'response.done') {
          this.responsePending = false;
          if (event.response?.status === 'failed') { this.fail(new Error('OpenAI could not complete the response. Check API access and usage limits.')); return; }
          if (!this.playing) this.update({ activity: 'listening' });
        }
        const transcript = applyEvent(this.state.transcript, event);
        if (transcript !== this.state.transcript) this.update({ transcript });
      };
      const onClose = () => { if (current()) this.fail(new Error('The voice connection closed. Start a new session to reconnect.')); };
      const onConnection = () => { if (current() && ['failed', 'closed'].includes(peer.connectionState)) onClose(); };
      channel.onmessage = (event: unknown) => onMessage(event as { data: string | ArrayBuffer });
      channel.onclose = onClose;
      channel.onerror = onClose;
      peer.onconnectionstatechange = onConnection;
      this.cleanups.push(() => {
        channel.onmessage = null;
        channel.onclose = null;
        channel.onerror = null;
        peer.onconnectionstatechange = null;
      });
      const offer = await peer.createOffer({ offerToReceiveAudio: true });
      if (!current()) return;
      await peer.setLocalDescription(offer);
      if (!current()) return;
      const response = await this.deps.fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST', headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/sdp' },
        body: offer.sdp, signal: abort.signal,
      });
      if (!current()) return;
      if (!response.ok) throw new Error(`OpenAI could not connect the voice session (HTTP ${response.status}). Check model access and API limits.`);
      const sdp = await response.text();
      if (!current()) return;
      await peer.setRemoteDescription({ type: 'answer', sdp });
      // Native WebRTC renders incoming audio without a browser Audio element.
    } catch (error) { if (current()) this.fail(error); }
  };

  stop = () => { this.release(); this.update({ status: 'ended', activity: 'listening', muted: false, endedAt: Date.now() }); };
  dispose = () => { this.release(); };
  toggleMute = () => {
    if (this.state.status !== 'connected') return;
    const muted = !this.state.muted;
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    this.update({ muted });
  };
  toggleSpeaker = () => {
    const speaker = !this.state.speaker;
    if (this.audioStarted) this.deps.setSpeaker(speaker);
    this.update({ speaker });
  };
  private sendEvent(event: object) {
    if (this.state.status !== 'connected' || this.channel?.readyState !== 'open') return;
    this.channel.send(JSON.stringify(event));
  }
  interrupt = () => {
    try {
      if (this.responsePending) this.sendEvent({ type: 'response.cancel' });
      if (this.playing) this.sendEvent({ type: 'output_audio_buffer.clear' });
    } catch (error) { this.fail(error); }
  };
  send = (text: string) => {
    if (!text.trim() || this.state.status !== 'connected' || this.responsePending || this.playing) return;
    try {
      this.sendEvent({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: text.trim() }] } });
      this.sendEvent({ type: 'response.create' });
      this.responsePending = true;
      this.update({ activity: 'thinking' });
    } catch (error) { this.fail(error); }
  };
}
