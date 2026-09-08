import { useEffect, useState } from 'react';
import { agentLabel } from '../shared/agent-identity.mjs';
import { RotateCcw } from 'lucide-react';
import { fetchCountingSnapshot, type CountingSnapshot } from './counting-api';
import { resetSharedCount } from './counting-connection';

export function useCountingSnapshot() {
  const [snapshot, setSnapshot] = useState<CountingSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();

    const refresh = async () => {
      try {
        const latest = await fetchCountingSnapshot(abort.signal);
        if (!abort.signal.aborted) { setSnapshot(latest); setError(null); }
      } catch (error) {
        if (!abort.signal.aborted) setError(error instanceof Error ? error.message : 'The counting room is unavailable.');
      }
    };
    void refresh();
    window.addEventListener('counting-state-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => { abort.abort(); window.removeEventListener('counting-state-changed', refresh); window.removeEventListener('focus', refresh); };
  }, []);
  return { snapshot, error };
}

export default function CountingProgress({ snapshot, error, inSession }: {
  snapshot: CountingSnapshot | null; error: string | null; inSession: boolean;
}) {
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const reset = async () => {
    if (!snapshot || !window.confirm('Stop every agent on every host first. Reset the shared count to 0?')) return;
    setResetting(true); setResetError(null);
    try { await resetSharedCount(); }
    catch (error) { setResetError(error instanceof Error ? error.message : 'Could not reset the count.'); }
    finally { setResetting(false); }
  };
  return <section className="shared-counter" aria-label="Shared counter">
    <p>Last observed count · <button className="text-button" onClick={() => window.dispatchEvent(new Event('counting-state-changed'))}>Refresh</button></p>
    <div className="counter-heading"><h2 aria-label="Reported count"><span data-testid="shared-count">{snapshot?.completedCount ?? '—'}</span><span className="counter-target"> / 100</span></h2>
      <button className="text-button" onClick={() => void reset()} disabled={!snapshot || inSession || resetting}><RotateCcw size={15} />{resetting ? 'Resetting…' : 'Reset count'}</button>
    </div>
    <progress aria-label="Group counting progress" max={100} value={snapshot?.completedCount ?? 0} />
    <p className="counter-status" role="status">{error ? error : !snapshot ? 'Connecting to the counting room…' : snapshot.finished ? 'The agents have counted to 100.' : !snapshot.counting ? `Counting is paused. Next number: ${snapshot.nextNumber}.` : snapshot.currentSpeakerId ? `${agentLabel(snapshot.currentSpeakerId)} is saying ${snapshot.nextNumber}.` : `Waiting for a participant to say ${snapshot.nextNumber}.`}</p>
    {resetError && <p role="alert">{resetError}</p>}
  </section>;
}
