import { useEffect, useState } from 'react';
import { api, type CapaItem, type Deviation, type QmsCapas } from '../api.js';
import { dmaicPhases, PHASES } from '../dmaic.js';

// S11 (D-31): DMAIC progress for one deviation, in plain words. A view only.
export function DmaicBar({ d, noCapaReason }: { d: Deviation; noCapaReason: string }) {
  const [capaSteps, setCapaSteps] = useState<string[]>([]);
  useEffect(() => {
    // D-63: with the QMS's CAPAs for this deviation when the QMS owns CAPA (a cancelled one does not count).
    void Promise.all([
      api<CapaItem[]>('GET', `/api/capas?deviationId=${d.id}&status=all`).then((c) => c.map((x) => x.step as string)).catch(() => []),
      api<QmsCapas>('GET', `/api/qms/capas?deviationId=${d.id}`).then((q) => q.capas.filter((x) => x.status !== 'cancelled')
        .map((x) => (x.status === 'closed' ? 'closed' : x.status === 'effectiveness_check' ? 'check' : 'open'))).catch(() => []),
    ]).then(([local, qms]) => setCapaSteps([...local, ...qms]));
  }, [d]);
  const phases = dmaicPhases(d.step, capaSteps, noCapaReason);
  if (!phases) return null;
  const label = { done: 'done', current: 'in progress', todo: 'to do' };
  return (
    <ol className="dmaic" aria-label="DMAIC progress">
      {phases.map((p) => (
        <li key={p.key} className={`phase ${p.state}`}>
          <a href={`#dmaic-${p.key}`} title={`${p.what}. On this page: ${p.where}.`}>
            <span className="letter">{p.key}</span>
            <span><b>{p.name}</b> <span className="small">· {label[p.state]}</span><br /><span className="muted small">{p.what}</span><span className="sr-only">. On this page: {p.where}.</span></span>
          </a>
        </li>
      ))}
    </ol>
  );
}

// The band that opens each phase on the deviation page; the bar above links to it.
export function PhaseHead({ k, step }: { k: keyof typeof PHASES; step: string }) {
  // A rejected planned deviation never went through the phases.
  if (step === 'rejected' || step === 'cancelled') return null;
  return (
    <div className="phase-head" id={`dmaic-${k}`}>
      <span className="letter">{k}</span> <b>{PHASES[k].name}</b> <span className="muted small">{PHASES[k].what}</span>
    </div>
  );
}
