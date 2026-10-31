import { useEffect, useState } from 'react';
import { api } from '../api.js';

// S8 (D-27): rule-based flags and similar earlier cases, in plain words. Advice only; nothing is saved.
interface Ref { id: number; number: string; title: string }
interface Flag { kind: string; text: string; deviations: Ref[] }
interface Similar extends Ref {
  step: string; why: string[]; rootCause: string; humanError: boolean;
  causes: { category: string; text: string }[]; capas: { number: string; description: string; step: string }[];
}
export interface SignalData { flags: Flag[]; similar: Similar[] }

export function Signals({ id, onOpen }: { id: number; onOpen: (id: number) => void }) {
  const [s, setS] = useState<SignalData | null>(null);
  useEffect(() => { api<SignalData>('GET', `/api/deviations/${id}/signals`).then(setS).catch(() => setS(null)); }, [id]);
  if (!s || (!s.flags.length && !s.similar.length)) return null;
  const link = (r: Ref) => <button key={r.id} className="link" onClick={() => onOpen(r.id)} title={r.title}>{r.number}</button>;
  return (
    <section className="card signals" aria-label="Things to look at">
      <h2>Things to look at</h2>
      <p className="muted small">The system found these by fixed rules. They are hints for the investigation, not conclusions.</p>
      {s.flags.length > 0 && (
        <ul className="flags">
          {s.flags.map((f) => (
            <li key={f.kind}><span className="chip chip-warn">{f.kind === 'late_report' ? 'late report' : f.kind === 'human_error' ? 'human error repeats' : `same ${f.kind}`}</span> {f.text}
              {f.deviations.length > 0 && <> See: {f.deviations.map((r, i) => <span key={r.id}>{i ? ', ' : ''}{link(r)}</span>)}</>}
            </li>
          ))}
        </ul>
      )}
      {s.similar.length > 0 && (
        <details open={s.flags.length === 0}>
          <summary><b>Similar earlier cases ({s.similar.length})</b>: what was found then may help now</summary>
          {s.similar.map((c) => (
            <div key={c.id} className="similar">
              <p>{link(c)} · {c.title} <span className="muted small">({c.why.join(', ')})</span></p>
              <p><b>Root cause found:</b> {c.rootCause}{c.humanError ? ' (human error)' : ''}</p>
              {c.causes.length > 0 && <p className="small">{c.causes.map((x) => `${x.category}: ${x.text}`).join(' · ')}</p>}
              {c.capas.length > 0 && <p className="small"><b>CAPAs:</b> {c.capas.map((x) => `${x.number} ${x.description}`).join(' · ')}</p>}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
