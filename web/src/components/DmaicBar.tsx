import { useEffect, useState } from 'react';
import { api, type CapaItem, type Deviation } from '../api.js';
import { dmaicPhases, PHASES } from '../dmaic.js';

// S11 (D-31): DMAIC progress for one deviation, in plain words. A view only.
export function DmaicBar({ d, noCapaReason }: { d: Deviation; noCapaReason: string }) {
  const [capaSteps, setCapaSteps] = useState<string[]>([]);
  useEffect(() => { api<CapaItem[]>('GET', `/api/capas?deviationId=${d.id}&status=all`).then((c) => setCapaSteps(c.map((x) => x.step))).catch(() => setCapaSteps([])); }, [d]);
  const phases = dmaicPhases(d.step, capaSteps, noCapaReason);
  if (!phases) return null;
  const label = { done: 'done', current: 'in progress', todo: 'to do' };
  return (
    <ol className="dmaic" aria-label="DMAIC progress">
      {phases.map((p) => (
        <li key={p.key} className={`phase ${p.state}`}>
          <a href={`#dmaic-${p.key}`} title={`${p.what}. On this page: ${p.where}.`}>
            <span className="letter">{p.key}</span>
            <span><b>{p.name}</b> <span className="small">· {label[p.state]}</span><br /><span className="muted small">{p.what}</span></span>
          </a>
        </li>
      ))}
    </ol>
  );
}

// The band that opens each phase on the deviation page; the bar above links to it.
export function PhaseHead({ k }: { k: keyof typeof PHASES }) {
  return (
    <div className="phase-head" id={`dmaic-${k}`}>
      <span className="letter">{k}</span> <b>{PHASES[k].name}</b> <span className="muted small">{PHASES[k].what}</span>
    </div>
  );
}
