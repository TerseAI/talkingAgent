import { useEffect, useState } from 'react';
import { agentLabel } from '../shared/agent-identity.mjs';
import { RotateCcw } from 'lucide-react';
import { counterRequest, type CounterSnapshot } from './counter-api';

export function useSharedCounter() {
  const [snapshot, setSnapshot] = useState<CounterSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();

    const refresh = async () => {
      try {
        const latest = await counterRequest<CounterSnapshot>('', undefined, abort.signal);
        if (!abort.signal.aborted) { setSnapshot(latest); setError(null); }
      } catch (error) {
        if (!abort.signal.aborted) setError(error instanceof Error ? error.message : 'The counter is unavailable.');
      }
    };
    void refresh();
    window.addEventListener('counter-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => { abort.abort(); window.removeEventListener('counter-changed', refresh); window.removeEventListener('focus', refresh); };
  }, []);
  return { snapshot, error };
}

export default function SharedCounter({ snapshot, error, inSession }: {
  snapshot: CounterSnapshot | null; error: string | null; inSession: boolean;
}) {
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const reset = async () => {
    if (!snapshot || !window.confirm('Stop every agent on every host first. Reset the shared count to 0?')) return;
    setResetting(true); setResetError(null);
    try { await counterRequest('reset', {}); }
    catch (error) { setResetError(error instanceof Error ? error.message : 'Could not reset the counter.'); }
    finally { setResetting(false); }
  };
  return <section className="shared-counter" aria-label="Shared counter">
    <p>Last observed counter state · <button className="text-button" onClick={() => window.dispatchEvent(new Event('counter-changed'))}>Refresh</button></p>
    <div className="counter-heading"><h2 aria-label="Reported count"><span data-testid="shared-count">{snapshot?.count ?? '—'}</span><span className="counter-target"> / 100</span></h2>
      <button className="text-button" onClick={() => void reset()} disabled={!snapshot || inSession || resetting}><RotateCcw size={15} />{resetting ? 'Resetting…' : 'Reset count'}</button>
    </div>
    <progress aria-label="Group counting progress" max={100} value={snapshot?.count ?? 0} />
    <p className="counter-status" role="status">{error ? error : !snapshot ? 'Connecting to the local counter…' : snapshot.done ? 'The agents have reported 100.' : snapshot.talkingStick ? `${agentLabel(snapshot.talkingStick)} has the talking stick for ${snapshot.number}.` : `The talking stick is free. Next number: ${snapshot.number}.`}</p>
    {resetError && <p role="alert">{resetError}</p>}
  </section>;
}
