import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { FISHBONE, type FishboneKey } from './Fishbone.js';

// S9 (D-29): possible causes suggested by AI, in simple words. Advice only: the investigator decides and signs.
interface Cause { category: FishboneKey; cause: string; why: string; howToCheck: string }
interface Suggestion { model: string; summary: string; causes: Cause[]; questions: string[]; otherBatches: string }
const LABEL = Object.fromEntries(FISHBONE) as Record<FishboneKey, string>;

export function AiSuggest({ deviationId, onAdd }: { deviationId: number; onAdd: (category: FishboneKey, text: string) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [s, setS] = useState<Suggestion | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  useEffect(() => { api<{ enabled: boolean }>('GET', '/api/ai/status').then((r) => setEnabled(r.enabled)).catch(() => setEnabled(false)); }, []);
  if (!enabled) return null;
  const ask = async () => {
    setBusy(true); setError(''); setAdded(new Set());
    try {
      setS(await api<Suggestion>('POST', `/api/deviations/${deviationId}/ai-suggest`, {}));
    } catch (e) {
      setError(e instanceof ApiError && e.message !== e.code ? e.message : 'The AI suggestions could not be fetched. Please try again later.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ai-help" role="region" aria-label="AI help">
      <div className="row">
        <button type="button" onClick={ask} disabled={busy}>{busy ? 'Thinking… (up to a minute)' : s ? 'Ask AI again' : 'Ask AI for possible causes'}</button>
        <span className="muted small">The AI reads this deviation and similar earlier ones. No names are sent. It only suggests: you check and decide.</span>
      </div>
      {error && <div className="error"><p>{error}</p></div>}
      {s && (
        <div className="ai-result">
          <p><span className="chip chip-info">AI suggestion</span> {s.summary}</p>
          <ol>
            {s.causes.map((c, i) => (
              <li key={i}>
                <b>{LABEL[c.category]}: {c.cause}</b>
                <p><span className="muted">Why it could fit:</span> {c.why}</p>
                <p><span className="muted">How to check:</span> {c.howToCheck}</p>
                <button type="button" className="link small" disabled={added.has(i)}
                  onClick={() => { onAdd(c.category, c.cause); setAdded(new Set(added).add(i)); }}>
                  {added.has(i) ? 'Added to fishbone' : 'Add to fishbone'}
                </button>
              </li>
            ))}
          </ol>
          {s.questions.length > 0 && <><b>Questions to ask the people involved</b><ul>{s.questions.map((q, i) => <li key={i}>{q}</li>)}</ul></>}
          {s.otherBatches && <p><b>Other batches to think about:</b> {s.otherBatches}</p>}
          <p className="muted small">Suggested by {s.model}. It can be wrong. Check every point yourself; the root cause you write and sign is your own.</p>
        </div>
      )}
    </div>
  );
}
