import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDownToLine, ArrowUp, AudioLines, LoaderCircle, Mic, MicOff, RotateCcw, Square, Volume2 } from 'lucide-react';
import { VoiceController, type VoiceState } from './voice-controller';
import CountingProgress, { useCountingState } from './CountingProgress';
import { agentName } from '../../shared/agent-identity.mjs';
import { AGENT_MODEL, AGENT_VOICE } from '../../shared/agent-config.mjs';

type ConfigState = 'loading' | 'ready' | 'missing' | 'error';

export function agentConsoleClass(activity: VoiceState['activity']) {
  if (activity === 'speaking') return 'agent-console is-speaking';
  if (activity === 'hearing') return 'agent-console is-hearing';
  return 'agent-console';
}

export function connectedStatus(voice: Pick<VoiceState, 'activity' | 'muted' | 'micGated'>) {
  if (voice.activity === 'speaking') return 'Assistant is speaking';
  if (voice.activity === 'thinking') return 'Thinking…';
  if (voice.muted) return 'Microphone muted';
  return 'Listening';
}

export default function App() {
  const [controller] = useState(() => new VoiceController());
  const voice = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [config, setConfig] = useState<ConfigState>('loading');
  const [agentVoice, setAgentVoice] = useState<string>(AGENT_VOICE);
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [draft, setDraft] = useState('');
  const { state: countingState, error: countingError } = useCountingState(toolsEnabled);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const configRequest = useRef<AbortController | null>(null);
  const conversation = voice.transcript.filter((entry) => entry.role !== 'event');
  const active = voice.status === 'connected';
  const connecting = voice.status === 'connecting';
  const inSession = active || connecting;

  const checkConfig = useCallback(async () => {
    configRequest.current?.abort();
    const request = new AbortController();
    configRequest.current = request;
    setConfig('loading');
    try {
      const response = await fetch('/api/config', { signal: AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]) });
      if (!response.ok) throw new Error('Server unavailable');
      const data = await response.json();
      if (!request.signal.aborted) {
        setAgentVoice(data.voice ?? AGENT_VOICE);
        setToolsEnabled(data.toolsEnabled === true);
        setConfig(data.configured ? 'ready' : 'missing');
      }
    } catch { if (!request.signal.aborted) setConfig('error'); }
  }, []);

  useEffect(() => {
    void checkConfig();
    const close = () => controller.stop();
    window.addEventListener('pagehide', close);
    return () => {
      configRequest.current?.abort();
      controller.dispose();
      window.removeEventListener('pagehide', close);
    };
  }, [controller, checkConfig]);

  useEffect(() => {
    const element = transcriptRef.current;
    if (element && pinnedToBottom.current) element.scrollTop = element.scrollHeight;
  }, [voice.transcript]);

  const status = connecting ? 'Connecting…'
    : active ? connectedStatus(voice)
    : voice.status === 'ended' ? 'Conversation ended' : voice.status === 'error' ? 'Connection interrupted' : 'Ready when you are';

  const start = () => { setDraft(''); pinnedToBottom.current = true; void controller.start(agentVoice); };
  const download = () => {
    const text = conversation.map((entry) => `${entry.timestamp ?? ''} ${entry.title ?? (entry.role === 'user' ? 'You' : agentName(agentVoice))} [${entry.status}]${entry.callId ? ` (${entry.callId})` : ''}: ${entry.text || '[No transcript]'}`).join('\n\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `conversation-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <main className={agentConsoleClass(voice.activity)}>
      <header className="console-header">
        <div><h1>{agentName(agentVoice)}</h1><p>{agentVoice} voice · OpenAI Realtime</p></div>
        <span className={`connection-tag ${active ? 'is-live' : ''}`}><span className="status-dot" />{active ? 'Connected' : connecting ? 'Connecting' : 'Offline'}</span>
      </header>

      <section className="agent-state" aria-label="Agent state">
        <h2 aria-live="polite">{status}</h2>
        <div className="controls">
          {inSession ? <button onClick={controller.stop}><Square size={14} />{connecting ? 'Cancel' : 'Disconnect'}</button>
            : <button className="primary" onClick={start} disabled={config !== 'ready'}>{config === 'loading' ? <LoaderCircle size={16} /> : <AudioLines size={16} />}{config === 'loading' ? 'Checking…' : 'Connect'}</button>}
          {active && <button onClick={controller.toggleMute} aria-pressed={voice.muted}>{voice.muted ? <MicOff size={16} /> : <Mic size={16} />}{voice.muted ? 'Unmute' : 'Mute'}</button>}
          {active && (voice.activity === 'speaking' || voice.activity === 'thinking') && <button onClick={controller.interrupt}>Stop response</button>}
        </div>
        {voice.playbackBlocked && <button onClick={() => void controller.enablePlayback()}><Volume2 size={16} />Enable audio</button>}
        {voice.error && <p className="error" role="alert">{voice.error}</p>}
        {(config === 'missing' || config === 'error') && <div className="error" role="alert"><p>{config === 'missing' ? 'Add OPENAI_API_KEY to .env and restart the API.' : 'API unavailable. Check the server is running.'}</p><button onClick={() => void checkConfig()}><RotateCcw size={14} />Retry</button></div>}
      </section>

      {toolsEnabled ? <CountingProgress state={countingState} error={countingError} inSession={inSession} /> : <section className="shared-counter"><h2>Actor</h2><p>{config === 'loading' ? 'Checking configuration…' : 'Disconnected · Coordination tools off'}</p></section>}

      <details className="conversation-details">
        <summary>Conversation & tools <span>{conversation.length}</span></summary>
        <div className="transcript-actions"><button onClick={download} disabled={!conversation.length}><ArrowDownToLine size={14} />Download</button></div>
            <div className="transcript-scroll" ref={transcriptRef} onScroll={(event) => { const element = event.currentTarget; pinnedToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
              {conversation.length ? <div className="messages" role="log" aria-label="Live conversation" aria-live="polite" aria-relevant="additions text">{conversation.map((entry, index) => <article key={entry.id} className={`message message-${entry.role}`}>
                <div className="message-label"><span>#{index + 1} · {entry.title ?? (entry.role === 'user' ? 'You' : agentName(agentVoice))}</span>
                  {entry.status === 'in_progress' && entry.role === 'tool' && <small>Pending</small>}
                  {entry.status === 'incomplete' && <small>{entry.role === 'tool' ? 'No result observed' : 'Interrupted'}</small>}
                </div>
                <div className="message-meta">{entry.timestamp?.slice(11, 23)} UTC{entry.callId && ` · ${entry.callId}`}</div>
                {entry.role === 'tool' ? <pre>{entry.text}</pre> : <p>{entry.text || (entry.status === 'in_progress' ? entry.role === 'user' ? 'Transcribing…' : 'Responding…' : '')}</p>}
              </article>)}</div>
                : <div className="empty-transcript"><div className="transcript-illustration" aria-hidden="true"><span /><span /><span /></div><h3>Say hello.</h3><p>{active ? 'Say something or type below. Your conversation will appear here.' : 'Start a conversation and your live transcript will appear here.'}</p></div>}
            </div>
            {<form className="message-form" onSubmit={(event) => { event.preventDefault(); if (draft.trim() && active) { controller.send(draft); setDraft(''); pinnedToBottom.current = true; } }}><label className="sr-only" htmlFor="message">Type a message</label><input id="message" autoComplete="off" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={!active} placeholder={active ? 'Type a message…' : 'Connect to type a message'} maxLength={4000} /><button aria-label="Send message" type="submit" disabled={!active || !draft.trim()}><ArrowUp size={18} /></button></form>}

      </details>
      <footer>{AGENT_MODEL}</footer>
    </main>
  );
}
