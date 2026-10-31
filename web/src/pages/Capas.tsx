import { useEffect, useState, type FormEvent } from 'react';
import {
  api, ApiError, CAPA_STEP_CHIP, CAPA_STEP_LABEL, MEANING_LABEL, plantDate, plantTime, SOURCE_LABEL,
  type Capa, type CapaItem, type Me,
} from '../api.js';
import { SignDialog } from '../components/SignDialog.js';

interface Person { id: number; fullName: string; username: string }
const problemsOf = (err: unknown) => (err instanceof ApiError && err.problems.length ? err.problems : ['Please fill in every field.']);
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

export function CapaTable({ rows, onOpen, showSource = true }: { rows: CapaItem[]; onOpen: (id: number) => void; showSource?: boolean }) {
  if (rows.length === 0) return <p className="muted">No CAPAs here.</p>;
  return (
    <table className="list">
      <thead>
        <tr><th>Number</th><th>What</th>{showSource && <th>Source</th>}<th>Owner</th><th>Status</th><th>Due</th></tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.id} className="click" onClick={() => onOpen(c.id)}>
            <td><button className="link">{c.number}</button></td>
            <td><span className="muted">{c.type === 'corrective' ? 'Corrective' : 'Preventive'} · </span>{c.description}</td>
            {showSource && <td>{c.source === 'deviation' ? c.deviationNumber : `${SOURCE_LABEL[c.source]}: ${c.sourceRef}`}</td>}
            <td>{c.owner}</td>
            <td><span className={`chip ${CAPA_STEP_CHIP[c.step]}`}>{CAPA_STEP_LABEL[c.step]}</span>{c.waitingForMe && <span className="chip chip-info">you</span>}</td>
            <td>{c.overdue ? <span className="chip chip-bad">Overdue · {plantDate(c.step === 'check' ? c.checkDue : c.dueDate)}</span> : plantDate(c.step === 'check' ? c.checkDue : c.step === 'closed' ? null : c.dueDate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// The CAPA register (D-13): one list, filtered by source, status and overdue.
export function CapaList({ me, onOpen }: { me: Me; onOpen: (id: number) => void }) {
  const [f, setF] = useState({ mine: false, status: 'open', source: '', overdue: false });
  const [rows, setRows] = useState<CapaItem[]>([]);
  const [raising, setRaising] = useState(false);
  const load = async () => {
    const q = new URLSearchParams({ status: f.status, ...(f.source ? { source: f.source } : {}), ...(f.overdue ? { overdue: '1' } : {}), ...(f.mine ? { mine: '1' } : {}) });
    setRows(await api<CapaItem[]>('GET', `/api/capas?${q}`));
  };
  useEffect(() => {
    void load();
  }, [f]);
  return (
    <>
      <div className="home-head">
        <h1>CAPAs</h1>
        {me.roles.includes('qa') && <button className="primary big" onClick={() => setRaising(true)}>New CAPA (audit, complaint, other)</button>}
      </div>
      {raising && <RaiseForm onCancel={() => setRaising(false)} onDone={(id) => { setRaising(false); onOpen(id); }} />}
      <div className="row filters">
        <label className="check"><input type="checkbox" checked={f.mine} onChange={(e) => setF({ ...f, mine: e.target.checked })} /> Waiting for me</label>
        <label className="check"><input type="checkbox" checked={f.overdue} onChange={(e) => setF({ ...f, overdue: e.target.checked })} /> Overdue only</label>
        <label>Status <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="open">Not closed</option><option value="closed">Closed</option><option value="all">All</option></select></label>
        <label>Source <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="">All</option>{Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <CapaTable rows={rows} onOpen={onOpen} />
    </>
  );
}

// DV-08: QA raises a CAPA, from a deviation (deviationId given) or directly with a source reference.
export function RaiseForm({ deviationId, onDone, onCancel, initial }: {
  deviationId?: number; onDone: (id: number) => void; onCancel: () => void; initial?: { source: string; sourceRef: string; description?: string };
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [f, setF] = useState({
    source: deviationId ? 'deviation' : initial?.source ?? 'audit', sourceRef: initial?.sourceRef ?? '', type: 'corrective',
    description: initial?.description ?? '', ownerId: 0, dueDate: '', product: '', batch: '',
  });
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => {
    void api<Person[]>('GET', '/api/people').then(setPeople);
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api<{ id: number }>('POST', '/api/capas', { ...f, ownerId: Number(f.ownerId), ...(deviationId ? { deviationId } : {}) });
      onDone(res.id);
    } catch (err) {
      setProblems(problemsOf(err));
    }
  };
  return (
    <form className="card form" onSubmit={submit}>
      <h2>{deviationId ? 'Raise a CAPA for this deviation' : 'New CAPA'}</h2>
      {!deviationId && (
        <div className="grid2">
          <label>Source<select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            <option value="audit">Internal audit</option><option value="complaint">Complaint</option><option value="other">Other</option>
          </select></label>
          <label>Reference (audit and finding, complaint number…)<input value={f.sourceRef} onChange={(e) => setF({ ...f, sourceRef: e.target.value })} /></label>
        </div>
      )}
      <fieldset className="choice">
        <label className="check"><input type="radio" checked={f.type === 'corrective'} onChange={() => setF({ ...f, type: 'corrective' })} /> Corrective</label>
        <label className="check"><input type="radio" checked={f.type === 'preventive'} onChange={() => setF({ ...f, type: 'preventive' })} /> Preventive</label>
      </fieldset>
      <label>What must be done<textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <div className="grid2">
        <label>Owner<select value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: Number(e.target.value) })}>
          <option value={0}>Choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.fullName} ({p.username})</option>)}
        </select></label>
        <label>Due date<input type="date" min={today()} value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></label>
      </div>
      {problems.length > 0 && <div className="error">{problems.map((p) => <p key={p}>{p}</p>)}</div>}
      <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Raise CAPA</button></div>
    </form>
  );
}

const nextStep = (c: Capa) =>
  c.step === 'open' ? `${c.owner} carries it out and marks it done.`
  : c.step === 'done' ? 'QA verifies it and decides how effectiveness is monitored.'
  : c.step === 'check' ? `QA records the effectiveness check by ${plantDate(c.checkDue)} and closes it.`
  : 'Closed.';

export function CapaPage({ me, id, onBack, onOpenDeviation, onOpenCapa }: {
  me: Me; id: number; onBack: () => void; onOpenDeviation: (id: number) => void; onOpenCapa: (id: number) => void;
}) {
  const [c, setC] = useState<Capa | null>(null);
  const [note, setNote] = useState('');
  const [eff, setEff] = useState({ mode: 'check', checkDue: '', how: '', reason: '' });
  const [check, setCheck] = useState({ effective: true, note: '' });
  const [signing, setSigning] = useState<'verify' | 'check' | null>(null);
  const [followUp, setFollowUp] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const load = async () => setC(await api<Capa>('GET', `/api/capas/${id}`));
  useEffect(() => {
    void load();
  }, [id]);
  if (!c) return <p>Loading…</p>;
  const data = c.versions[c.versions.length - 1]!.data as Record<string, unknown>;
  const isQa = me.roles.includes('qa');
  const effectiveness = data.effectiveness as { mode: string; checkDue?: string; how?: string; reason?: string } | undefined;
  const result = data.checkResult as { effective: boolean; note: string } | undefined;

  const done = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', `/api/capas/${id}/done`, { note });
      await load();
    } catch (err) {
      setProblems(problemsOf(err));
    }
  };
  const effBody = () => (eff.mode === 'check' ? { mode: 'check', checkDue: eff.checkDue, how: eff.how } : { mode: 'trend', reason: eff.reason });

  return (
    <>
      <button className="link" onClick={onBack}>← CAPAs</button>
      <h1>{c.number} · {data.type === 'corrective' ? 'Corrective' : 'Preventive'} action</h1>
      <div className={`statusbar ${c.overdue ? 'blocked' : 'fit'}`}>
        <span className={`chip ${CAPA_STEP_CHIP[c.step]}`}>{CAPA_STEP_LABEL[c.step]}</span>
        <span>Due: <b>{plantDate(c.dueDate)}</b>{c.overdue && <span className="chip chip-bad">Overdue</span>}</span>
        <span className="next">Next: {nextStep(c)}</span>
      </div>
      <section className="card">
        <dl className="fields">
          <div><dt>Source</dt><dd>{c.source === 'deviation' ? <button className="link" onClick={() => onOpenDeviation(c.deviationId!)}>{c.deviationNumber}</button> : `${SOURCE_LABEL[c.source]}: ${c.sourceRef}`}</dd></div>
          <div><dt>What must be done</dt><dd>{String(data.description)}</dd></div>
          <div><dt>Owner</dt><dd>{c.owner}</dd></div>
          <div><dt>Raised by</dt><dd>{c.raisedBy} · {plantTime(c.raisedAt)}</dd></div>
          {typeof data.doneNote === 'string' && <div><dt>What was done</dt><dd>{data.doneNote}</dd></div>}
          {effectiveness && <div><dt>Effectiveness</dt><dd>{effectiveness.mode === 'check' ? `Dedicated check by ${plantDate(effectiveness.checkDue ?? null)}: ${effectiveness.how}` : `Monitored through the trend and quality review: ${effectiveness.reason}`}</dd></div>}
          {result && <div><dt>Check result</dt><dd>{result.effective ? 'Effective' : 'Not effective'}: {result.note}</dd></div>}
        </dl>
        {c.signatures.map((s) => <p key={s.id} className="signature">✔ {MEANING_LABEL[s.meaning] ?? s.meaning} · {s.printedName} · {plantTime(s.signedAt)}</p>)}
      </section>

      {c.step === 'open' && (c.ownerId === me.id || isQa) && (
        <form className="card form" onSubmit={done}>
          <h2>Mark as done</h2>
          <label>What was done (with record references)<textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="actions"><button className="primary" type="submit">Mark done</button></div>
        </form>
      )}

      {c.step === 'done' && isQa && (
        <form className="card form" onSubmit={(e) => { e.preventDefault(); setSigning('verify'); }}>
          <h2>Verify and decide on effectiveness</h2>
          <label className="check"><input type="radio" checked={eff.mode === 'check'} onChange={() => setEff({ ...eff, mode: 'check' })} /> Dedicated effectiveness check</label>
          {eff.mode === 'check' && (
            <div className="grid2">
              <label>Check by<input type="date" min={today()} value={eff.checkDue} onChange={(e) => setEff({ ...eff, checkDue: e.target.value })} /></label>
              <label>How it will be checked<input value={eff.how} onChange={(e) => setEff({ ...eff, how: e.target.value })} /></label>
            </div>
          )}
          <label className="check"><input type="radio" checked={eff.mode === 'trend'} onChange={() => setEff({ ...eff, mode: 'trend' })} /> Monitored through the trend and quality review (closes the CAPA now)</label>
          {eff.mode === 'trend' && <label>Why no dedicated check is needed<input value={eff.reason} onChange={(e) => setEff({ ...eff, reason: e.target.value })} /></label>}
          <div className="actions"><button className="primary" type="submit">Sign verified</button></div>
        </form>
      )}

      {c.step === 'check' && isQa && (
        <form className="card form" onSubmit={(e) => { e.preventDefault(); setSigning('check'); }}>
          <h2>Effectiveness check result</h2>
          <fieldset className="choice">
            <label className="check"><input type="radio" checked={check.effective} onChange={() => setCheck({ ...check, effective: true })} /> Effective</label>
            <label className="check"><input type="radio" checked={!check.effective} onChange={() => setCheck({ ...check, effective: false })} /> Not effective</label>
          </fieldset>
          <label>Evidence<textarea rows={2} value={check.note} onChange={(e) => setCheck({ ...check, note: e.target.value })} /></label>
          <div className="actions"><button className="primary" type="submit">Sign and close</button></div>
        </form>
      )}

      {c.step === 'closed' && result && !result.effective && isQa && (
        followUp
          ? <RaiseForm deviationId={c.deviationId ?? undefined} initial={{ source: c.source, sourceRef: c.sourceRef || c.number, description: `Follow-up of ${c.number}: ` }}
              onCancel={() => setFollowUp(false)} onDone={(newId) => { setFollowUp(false); onOpenCapa(newId); }} />
          : <div className="notice">This CAPA was not effective. <button className="primary" onClick={() => setFollowUp(true)}>Raise a follow-up CAPA</button></div>
      )}
      {problems.length > 0 && <div className="error">{problems.map((p) => <p key={p}>{p}</p>)}</div>}

      <section className="card">
        <h2>History</h2>
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Reason</th></tr></thead>
          <tbody>{c.history.map((h) => <tr key={h.id}><td>{plantTime(h.at)}</td><td>{h.actor}</td><td>{h.action.replace('capa.', '').replaceAll('_', ' ')}</td><td>{h.reason}</td></tr>)}</tbody>
        </table>
      </section>

      {signing && (
        <SignDialog meaning={signing === 'verify' ? 'verified' : 'closed'} what={`${c.number}: ${signing === 'verify' ? 'the action was done as described; effectiveness as chosen.' : `effectiveness ${check.effective ? 'confirmed' : 'NOT confirmed'}; the CAPA is closed.`}`}
          onCancel={() => setSigning(null)}
          onSign={async (cred) => {
            if (signing === 'verify') await api('POST', `/api/capas/${id}/verify`, { effectiveness: effBody(), signature: cred });
            else await api('POST', `/api/capas/${id}/check`, { ...check, signature: cred });
            setSigning(null);
            await load();
          }} />
      )}
    </>
  );
}
