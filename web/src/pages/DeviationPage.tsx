import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  api, ApiError, CLASS_LABEL, MEANING_LABEL, plantDate, plantTime, STEP_CHIP, STEP_LABEL,
  type Deviation, type Me, type NamedItem, type SectionVersion,
} from '../api.js';
import { SignDialog } from '../components/SignDialog.js';

interface Person { id: number; fullName: string; username: string }

const latestOf = (d: Deviation, kind: SectionVersion['kind']) => d.sections.find((s) => s.kind === kind && s.latest);
const str = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : String(v));

function Fields({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="fields">
      {rows.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

// Who must act next, in plain words.
function nextAction(d: Deviation): string {
  switch (d.step) {
    case 'classification': return 'QA classifies the deviation (not the person who reported it).';
    case 'approval': return 'QA approves or rejects the planned deviation. Do not proceed before approval.';
    case 'investigation': return `${d.investigator ?? 'The investigator'} investigates the root cause.`;
    case 'closure': return 'QA reviews and closes the deviation.';
    case 'closed': return 'Closed.';
    case 'rejected': return 'Rejected: the planned deviation must not be carried out.';
  }
}

export function DeviationPage({ me, id, onBack }: { me: Me; id: number; onBack: () => void }) {
  const [d, setD] = useState<Deviation | null>(null);
  const [signing, setSigning] = useState<'approved' | 'rejected' | null>(null);
  const load = async () => setD(await api<Deviation>('GET', `/api/deviations/${id}`));
  useEffect(() => {
    void load();
  }, [id]);
  if (!d) return <p>Loading…</p>;

  const isQa = me.roles.includes('qa');
  const report = latestOf(d, 'report')!.data as Record<string, unknown>;
  const classification = latestOf(d, 'classification');
  const own = d.batches.filter((b) => b.role === 'own');

  return (
    <>
      <button className="link" onClick={onBack}>← All deviations</button>
      <h1>{d.number} · {str(report.title)}</h1>
      <div className={`statusbar ${d.overdue ? 'blocked' : 'fit'}`}>
        <span className={`chip ${STEP_CHIP[d.step]}`}>{STEP_LABEL[d.step]}</span>
        {d.classification && <span className="chip">{CLASS_LABEL[d.classification]}</span>}
        <span>Target date: <b>{plantDate(d.targetDate)}</b>{d.overdue && <span className="chip chip-bad">Overdue</span>}</span>
        <span className="next">Next: {nextAction(d)}</span>
      </div>

      <section className="card">
        <h2>1. Report{d.planned ? ' (planned deviation)' : ''}</h2>
        <Fields rows={[
          ['What happened', str(report.description)],
          ...(d.planned ? [['Reason for the planned deviation', str(report.plannedReason)] as [string, ReactNode]] : []),
          ['Area', str(d.area)],
          ['Equipment', str(report.equipment)],
          [d.planned ? 'Planned for' : 'When it happened', plantTime(str(report.eventAt))],
          ['Product / batch', own.length ? own.map((b) => `${b.product} / ${b.batch}`).join('; ') : 'None concerned'],
          ['Immediate action', str(report.immediateAction)],
          ['Reported by', `${d.reporter} · ${plantTime(d.reportedAt)}`],
        ]} />
      </section>

      <section className="card">
        <h2>2. Classification</h2>
        {classification ? (
          <Classified d={d} c={classification} />
        ) : d.step === 'classification' && isQa && d.reporterId !== me.id ? (
          <ClassifyForm id={d.id} onDone={load} />
        ) : (
          <p className="muted">{d.reporterId === me.id && isQa ? 'You reported this deviation, so another QA person classifies it.' : 'Waiting for QA.'}</p>
        )}
        {d.step === 'approval' && isQa && d.reporterId !== me.id && (
          <div className="actions">
            <button onClick={() => setSigning('rejected')}>Reject</button>
            <button className="primary" onClick={() => setSigning('approved')}>Approve planned deviation</button>
          </div>
        )}
        {d.signatures.map((s) => (
          <p key={s.id} className="signature">✔ {MEANING_LABEL[s.meaning] ?? s.meaning} · {s.printedName} · {plantTime(s.signedAt)}</p>
        ))}
      </section>

      <section className="card muted-card">
        <h2>3. Investigation · CAPAs · Closure</h2>
        <p className="muted">{d.step === 'investigation' ? nextAction(d) : 'Follows classification.'}</p>
      </section>

      <section className="card">
        <h2>History</h2>
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Reason</th></tr></thead>
          <tbody>
            {d.history.map((h) => (
              <tr key={h.id}><td>{plantTime(h.at)}</td><td>{h.actor ?? 'System'}</td><td>{h.action.replace('deviation.', '').replaceAll('_', ' ')}</td><td>{h.reason}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      {signing && (
        <ApproveDialog d={d} meaning={signing} onCancel={() => setSigning(null)} onDone={async () => { setSigning(null); await load(); }} />
      )}
    </>
  );
}

function Classified({ d, c }: { d: Deviation; c: SectionVersion }) {
  const [types, setTypes] = useState<NamedItem[]>([]);
  useEffect(() => {
    void api<NamedItem[]>('GET', '/api/deviation-types').then(setTypes);
  }, []);
  const data = c.data as Record<string, unknown>;
  return (
    <Fields rows={[
      ['Classification', CLASS_LABEL[str(data.classification)] ?? '—'],
      ['Type', types.find((t) => t.id === data.typeId)?.name ?? '—'],
      ['Impact assessment', str(data.impact)],
      ['Investigator', str(d.investigator)],
      ['Product and batch', 'Checked by QA'],
      ['Classified by', `${c.savedBy} · ${plantTime(c.savedAt)}`],
    ]} />
  );
}

function ClassifyForm({ id, onDone }: { id: number; onDone: () => Promise<void> }) {
  const [types, setTypes] = useState<NamedItem[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [f, setF] = useState({ classification: '', typeId: 0, impact: '', investigatorId: 0, productBatchChecked: false });
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => {
    void api<NamedItem[]>('GET', '/api/deviation-types').then((t) => setTypes(t.filter((x) => x.active)));
    void api<Person[]>('GET', '/api/people').then(setPeople);
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', `/api/deviations/${id}/classify`, { ...f, typeId: Number(f.typeId), investigatorId: Number(f.investigatorId) });
      await onDone();
    } catch (err) {
      setProblems(err instanceof ApiError && err.problems.length ? err.problems : ['Please fill in every field.']);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <fieldset className="choice">
        {(['minor', 'major', 'critical'] as const).map((k) => (
          <label key={k} className="check"><input type="radio" name="classification" checked={f.classification === k} onChange={() => setF({ ...f, classification: k })} /> {CLASS_LABEL[k]}</label>
        ))}
      </fieldset>
      <div className="grid2">
        <label>Type
          <select value={f.typeId} onChange={(e) => setF({ ...f, typeId: Number(e.target.value) })}>
            <option value={0}>Choose…</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label>Investigator
          <select value={f.investigatorId} onChange={(e) => setF({ ...f, investigatorId: Number(e.target.value) })}>
            <option value={0}>Choose…</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.fullName} ({p.username})</option>)}
          </select>
        </label>
      </div>
      <label>Impact assessment (product, batches, other batches possibly affected)<textarea rows={3} value={f.impact} onChange={(e) => setF({ ...f, impact: e.target.value })} /></label>
      <label className="check"><input type="checkbox" checked={f.productBatchChecked} onChange={(e) => setF({ ...f, productBatchChecked: e.target.checked })} /> I checked the product and batch numbers against the batch record</label>
      {problems.length > 0 && <div className="error">{problems.map((p) => <p key={p}>{p}</p>)}</div>}
      <div className="actions"><button className="primary" type="submit">Save classification</button></div>
    </form>
  );
}

function ApproveDialog({ d, meaning, onCancel, onDone }: { d: Deviation; meaning: 'approved' | 'rejected'; onCancel: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  return (
    <SignDialog
      meaning={meaning}
      what={`${d.number}: ${meaning === 'approved' ? 'the planned deviation may be carried out as reported and classified.' : 'the planned deviation must not be carried out.'}`}
      onCancel={onCancel}
      onSign={async (cred) => {
        await api('POST', `/api/deviations/${d.id}/${meaning === 'approved' ? 'approve' : 'reject'}`, { ...cred, contentHash: d.approvalHash, ...(meaning === 'rejected' ? { reason } : {}) });
        await onDone();
      }}
    >
      {meaning === 'rejected' && <label>Reason<textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
    </SignDialog>
  );
}
