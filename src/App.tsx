import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDownToLine, ArrowUp, AudioLines, Check, ChevronRight, CircleHelp, LoaderCircle, Mic, MicOff, Radio, RotateCcw, Square, Volume2, X } from 'lucide-react';
import { VoiceController } from './voice-controller';
import CountingProgress, { useCountingSnapshot } from './CountingProgress';
import { agentName } from '../shared/agent-identity.mjs';
import { AGENT_MODEL, AGENT_VOICE } from '../shared/agent-config.mjs';

type ConfigState = 'loading' | 'ready' | 'missing' | 'error';

export default function App() {
  const [controller] = useState(() => new VoiceController());
  const voice = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [config, setConfig] = useState<ConfigState>('loading');
  const [agentVoice, setAgentVoice] = useState<string>(AGENT_VOICE);
  const [showHelp, setShowHelp] = useState(false);
  const [draft, setDraft] = useState('');
  const { snapshot: countingSnapshot, error: countingError } = useCountingSnapshot();
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
    : active ? voice.activity === 'speaking' ? 'Assistant is speaking' : voice.activity === 'thinking' ? 'Thinking…' : voice.muted ? 'Microphone muted' : 'Listening to you'
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
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="Talking Agent home"><span className="brand-symbol"><AudioLines size={23} /></span>Talking Agent</a>
        <div className="header-actions">
          <span className={`connection-tag ${active ? 'is-live' : ''}`}><span className="status-dot" />{active ? 'Connected' : connecting ? 'Connecting' : 'Offline'}</span>
          <button className="icon-button" aria-label={showHelp ? 'Close help' : 'Open help'} aria-expanded={showHelp} aria-controls="help-panel" onClick={() => setShowHelp(!showHelp)}>{showHelp ? <X size={20} /> : <CircleHelp size={20} />}</button>
        </div>
      </header>

      <main>
        <div className="page-intro"><h1>Talk to your agent.</h1><p>Ask a question, or ask it to count with the other agents.</p></div>
        <CountingProgress snapshot={countingSnapshot} error={countingError} inSession={inSession} />
        <p className="counting-hint">Counting starts when you ask. You can interrupt and talk anytime.</p>

        {showHelp && <section id="help-panel" className="help-panel"><h2>Voice conversation</h2><p>Allow microphone access and speak normally. You can interrupt, mute your microphone, or type a message. Each tab has its own agent; their counter is shared.</p><p>The count reflects numbers reported by the agents, not verified audio playback. Audio is sent to OpenAI during a call. The transcript stays in this page until you reload.</p><a href="https://developers.openai.com/api/docs/guides/voice-agents" target="_blank" rel="noreferrer">OpenAI voice agent documentation <ChevronRight size={15} /></a></section>}

        {(config === 'missing' || config === 'error') && <section className="setup-notice" aria-label="Connection setup">
          <div><h2>{config === 'missing' ? 'One thing before we talk' : 'The server isn’t responding'}</h2><p>{config === 'missing' ? <>Add your key as <code>OPENAI_API_KEY</code> in <code>.env</code>, then restart the server. Your key stays on the server.</> : 'Check that the local server is running, then try again.'}</p></div>
          <button className="text-button" onClick={() => void checkConfig()}><RotateCcw size={15} />Check again</button>
        </section>}

        <div className="workspace">
          <section className="voice-panel" aria-label="Voice conversation controls">
            <div className="panel-topline"><span className="assistant-label"><span className="mini-dot" />{agentName(agentVoice)}</span><span className="voice-label">{agentVoice} voice</span></div>
            <div className="voice-stage">
              <div className={`voice-emblem ${active ? 'is-active' : ''} ${voice.activity === 'speaking' && active ? 'is-speaking' : ''}`} aria-hidden="true"><AudioLines strokeWidth={1.3} /></div>
              <h2 aria-live="polite">{status}</h2>
              <p>{connecting ? 'Allow microphone access to connect.' : active ? 'Speak or type a message.' : 'Start a conversation when you’re ready.'}</p>
              <div className="main-controls">
                {inSession ? <>
                  <button className="end-button" onClick={controller.stop}><Square size={15} fill="currentColor" />{connecting ? 'Cancel connection' : 'End conversation'}</button>
                  {active && <button className={`mute-button ${voice.muted ? 'is-muted' : ''}`} onClick={controller.toggleMute} aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={voice.muted}>{voice.muted ? <MicOff size={20} /> : <Mic size={20} />}</button>}
                </> : <button className="start-button" onClick={start} disabled={config !== 'ready'}>{config === 'loading' ? <LoaderCircle className="spin" size={19} /> : <AudioLines size={19} />}{config === 'loading' ? 'Checking connection' : voice.status === 'ended' || voice.status === 'error' ? 'Start a new conversation' : 'Start conversation'}</button>}
              </div>
              {active && (voice.activity === 'speaking' || voice.activity === 'thinking') && <button className="interrupt-button" onClick={controller.interrupt}><Square size={11} />Stop response</button>}
              {voice.playbackBlocked && <button className="enable-audio" onClick={() => void controller.enablePlayback()}><Volume2 size={17} />Enable assistant audio</button>}
            </div>
            {voice.error && <div className="session-error" role="alert"><p>{voice.error}</p></div>}
            <div className="session-details"><span><Radio size={14} />Voice conversation</span><span>{!active || voice.muted ? 'Microphone off' : voice.micGated ? 'Microphone paused while another agent counts' : 'Microphone on'}</span></div>
          </section>

          <section className="transcript-panel" aria-label="Conversation transcript">
            <div className="transcript-header"><div><h2>Conversation</h2><span>{conversation.length ? `${conversation.length} entries · order received` : 'Your words, as they happen'}</span></div><button className="icon-button" aria-label="Download transcript" title="Download transcript" disabled={!conversation.length} onClick={download}><ArrowDownToLine size={19} /></button></div>
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
          </section>
        </div>

        <footer className="app-footer"><span><Check size={14} />{inSession ? 'End the conversation to disconnect your microphone.' : 'Your microphone turns on when you start.'}</span><span>AI voice · {AGENT_MODEL}</span></footer>
      </main>
    </div>
  );
}
