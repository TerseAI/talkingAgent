import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { TARGET_COUNT } from '../../shared/counting-protocol.mjs';
import { fetchCountingState, type CountingState } from '../../src/counting-api';
import { resetSharedCount } from '../../src/counting-connection';

export function useCountingState(enabled = true) {
  const [state, setState] = useState<CountingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();

    const refresh = async () => {
      try {
        const latest = await fetchCountingState(abort.signal);
        if (!abort.signal.aborted) { setState(latest); setError(null); }
      } catch (error) {
        if (!abort.signal.aborted) setError(error instanceof Error ? error.message : 'The counting room is unavailable.');
      }
    };
    void refresh();
    window.addEventListener('counting-state-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => { abort.abort(); window.removeEventListener('counting-state-changed', refresh); window.removeEventListener('focus', refresh); };
  }, [enabled]);
  return { state, error };
}

export default function CountingProgress({ state, error, inSession }: {
  state: CountingState | null; error: string | null; inSession: boolean;
}) {
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const reset = async () => {
    if (!state || !window.confirm('Stop every agent on every host first. Reset the shared count to 0?')) return;
    setResetting(true); setResetError(null);
    try { await resetSharedCount(); }
    catch (error) { setResetError(error instanceof Error ? error.message : 'Could not reset the count.'); }
    finally { setResetting(false); }
  };
  const finished = state?.count === TARGET_COUNT;
  return <section className="shared-counter" aria-label="Actor state">
    <div className="actor-heading"><h2>Actor</h2><button className="text-button" onClick={() => window.dispatchEvent(new Event('counting-state-changed'))}>Refresh</button></div>
    <dl className="actor-values">
      <div><dt>Count</dt><dd data-testid="shared-count">{state?.count ?? '—'} <span>/ 100</span></dd></div>
      <div><dt>State</dt><dd>{error ? 'Unavailable' : !state ? 'Loading…' : finished ? 'Finished' : state.running ? 'Counting' : 'Paused'}</dd></div>
    </dl>
    <p className="counter-status" role="status">{error || (!state ? 'Reading actor state…' : finished ? 'Count complete.' : state.running ? `Counting · ${state.count + 1}` : `Next number: ${state.count + 1}`)}</p>
    <div className="actor-footer"><small>Last observed state</small><button className="text-button" onClick={() => void reset()} disabled={!state || inSession || resetting}><RotateCcw size={13} />{resetting ? 'Resetting…' : 'Reset'}</button></div>
    {resetError && <p className="error" role="alert">{resetError}</p>}
  </section>;
}
