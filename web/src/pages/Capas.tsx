import { useEffect, useState, type FormEvent } from 'react';
import {
  api, ApiError, can, CAPA_STEP_CHIP, CAPA_STEP_LABEL, MEANING_LABEL, plantDate, plantTime, SOURCE_LABEL,
  QMS_CLOSED, type Capa, type CapaItem, type Me, type QmsCapa, type QmsCapas,
} from '../api.js';
import { SignDialog } from '../components/SignDialog.js';

interface Person { id: number; fullName: string; username: string }
// A 503 is a cut link ("Connection to core is off", D-44): its message is shown as it is.
const problemsOf = (err: unknown) => (err instanceof ApiError && err.problems.length ? err.problems
  : err instanceof ApiError && err.status === 503 ? [err.message] : ['Please fill in every field.']);
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
            <td><span className="muted">{c.type === 'corrective' ? 'Corrective' : 'Preventive'} · </span>{c.description}
              {c.strength && <span className={`chip ${c.strength === 'weak' ? 'chip-warn' : 'chip-ok'}`}>{c.strength}</span>}</td>
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

// D-63: the QMS's CAPAs, read-only (the QMS owns CAPA while it is linked); opened and worked on in the QMS.
export function QmsCapaTable({ q }: { q: QmsCapas }) {
  if (q.off) return <div className="notice"><span className="chip chip-bad">QMS link off</span> {q.note}</div>;
  if (q.capas.length === 0) return <p className="muted">No CAPAs in QMS here.</p>;
  return (
    <table className="list">
      <thead><tr><th>Number</th><th>Title</th><th>Owner</th><th>Status</th><th>Due</th><th>Effective</th></tr></thead>
      <tbody>
        {q.capas.map((c: QmsCapa) => (
          <tr key={c.capa_number}>
            <td>{c.capa_number} <span className="chip chip-info">from QMS</span></td>
            <td>{c.title}{c.source_kind === 'deviation' && c.source_ref ? <span className="muted small"> · {c.source_ref}</span> : null}</td>
            <td>{c.owner_name ?? '—'}</td>
            <td><span className={`chip ${QMS_CLOSED.includes(c.status) ? 'chip-ok' : 'chip-info'}`}>{c.status_text}</span></td>
            <td>{plantDate(c.due_date)}</td>
            <td>{c.effective === null ? '—' : c.effective ? 'Yes' : 'No'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** D-63: the link to the QMS new-CAPA screen (pre-filled with the deviation number when given), or why there is none. */
export function RaiseInQms({ q }: { q: QmsCapas }) {
  if (q.off) return null;
  return q.newCapaUrl
    ? <a className="button primary" href={q.newCapaUrl} target="_blank" rel="noopener">Raise CAPA in QMS</a>
    : <p className="muted small">CAPAs are raised in QMS.</p>;
}

const NOT_LINKED: QmsCapas = { linked: false, off: false, note: null, newCapaUrl: null, capas: [] };
/** D-63: the QMS's CAPAs for a deviation (`deviationId`), the QMS register (`register=1`), or only whether it is linked. */
export function useQms(query: string, deps: unknown[] = []): QmsCapas {
  const [q, setQ] = useState<QmsCapas>(NOT_LINKED);
  useEffect(() => {
    api<QmsCapas>('GET', `/api/qms/capas${query ? `?${query}` : ''}`).then(setQ, () => setQ(NOT_LINKED));
  }, deps);
  return q;
}

// The CAPA register (D-13): one list, filtered by source, status and overdue.
// D-63: while the QMS is linked, the register is the QMS's (read-only here); local CAPAs raised before stay listed below.
export function CapaList({ me, onOpen }: { me: Me; onOpen: (id: number) => void }) {
  const [f, setF] = useState({ mine: false, status: 'open', source: '', overdue: false });
  const [rows, setRows] = useState<CapaItem[]>([]);
  const [raising, setRaising] = useState(false);
  const qms = useQms('register=1');
  const load = async () => {
    const q = new URLSearchParams({ status: f.status, ...(f.source ? { source: f.source } : {}), ...(f.overdue ? { overdue: '1' } : {}), ...(f.mine ? { mine: '1' } : {}) });
    setRows(await api<CapaItem[]>('GET', `/api/capas?${q}`));
  };
  useEffect(() => {
    void load();
  }, [f]);
  const qmsRows = qms.capas.filter((c) => f.status === 'all' || (f.status === 'closed') === QMS_CLOSED.includes(c.status));
  return (
    <>
      <div className="home-head">
        <h1>CAPAs</h1>
        {qms.linked ? can(me, 'deviations.capa.raise') && <RaiseInQms q={qms} />
          : can(me, 'deviations.capa.raise') && <button className="primary big" onClick={() => setRaising(true)}>New CAPA (audit, complaint, other)</button>}
      </div>
      {raising && <RaiseForm onCancel={() => setRaising(false)} onDone={(id) => { setRaising(false); onOpen(id); }} />}
      {qms.linked && (
        <section className="card">
          <h2>CAPAs in QMS</h2>
          <p className="muted small">QMS owns CAPA: these are read from QMS and worked on there. Status filter applies.</p>
          <QmsCapaTable q={{ ...qms, capas: qmsRows }} />
        </section>
      )}
      {qms.linked && <h2>CAPAs recorded here before QMS was linked</h2>}
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

// S14 (D-36): CAPA strength, strongest first.
export const STRENGTH_LABEL: Record<string, string> = {
  strong: 'Strong: mistake-proofing, interlock, barcode check',
  medium: 'Medium: automation, alarm, checklist',
  weak: 'Weak: training, SOP revision, awareness',
};

// DV-08: QA raises a CAPA, from a deviation (deviationId given) or directly with a source reference.
export function RaiseForm({ deviationId, onDone, onCancel, initial }: {
  deviationId?: number; onDone: (id: number) => void; onCancel: () => void; initial?: { source: string; sourceRef: string; description?: string };
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [f, setF] = useState({
    source: deviationId ? 'deviation' : initial?.source ?? 'audit', sourceRef: initial?.sourceRef ?? '', type: 'corrective',
    description: initial?.description ?? '', ownerId: 0, dueDate: '', product: '', batch: '', strength: '',
  });
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => {
    api<Person[]>('GET', '/api/people').then(setPeople, (err: Error) => setProblems([err.message]));
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
      <label>Strength<select value={f.strength} onChange={(e) => setF({ ...f, strength: e.target.value })}>
        <option value="">Choose…</option>
        {Object.entries(STRENGTH_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select></label>
      <p className="muted small">Strongest first: a system that will not allow the wrong action. Training or an SOP change alone is weak and is not enough for a critical deviation.</p>
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
  const qms = useQms('', [id]);
  const [problems, setProblems] = useState<string[]>([]);
  const load = async () => setC(await api<Capa>('GET', `/api/capas/${id}`));
  useEffect(() => {
    void load();
  }, [id]);
  if (!c) return <p>Loading…</p>;
  const data = c.versions[c.versions.length - 1]!.data as Record<string, unknown>;
  const verifier = can(me, 'deviations.capa.verify');
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
      <div className="home-head"><h1>{c.number} · {data.type === 'corrective' ? 'Corrective' : 'Preventive'} action</h1><a className="button" href={`/api/capas/${c.id}/pdf`}>Print PDF</a></div>
      <div className={`statusbar ${c.overdue ? 'blocked' : 'fit'}`}>
        <span className={`chip ${CAPA_STEP_CHIP[c.step]}`}>{CAPA_STEP_LABEL[c.step]}</span>
        <span>{c.step === 'check' ? 'Check due' : 'Due'}: <b>{plantDate(c.step === 'check' ? c.checkDue : c.dueDate)}</b>{c.overdue && <span className="chip chip-bad">Overdue</span>}</span>
        <span className="next">Next: {nextStep(c)}</span>
      </div>
      <section className="card">
        <dl className="fields">
          <div><dt>Source</dt><dd>{c.source === 'deviation' ? <button className="link" onClick={() => onOpenDeviation(c.deviationId!)}>{c.deviationNumber}</button> : `${SOURCE_LABEL[c.source]}: ${c.sourceRef}`}</dd></div>
          <div><dt>What must be done</dt><dd>{String(data.description)}</dd></div>
          <div><dt>Strength</dt><dd>{data.strength ? STRENGTH_LABEL[String(data.strength)] : 'Not set (raised before strengths were recorded)'}</dd></div>
          <div><dt>Owner</dt><dd>{c.owner}</dd></div>
          <div><dt>Raised by</dt><dd>{c.raisedBy} · {plantTime(c.raisedAt)}</dd></div>
          {typeof data.doneNote === 'string' && <div><dt>What was done</dt><dd>{data.doneNote}</dd></div>}
          {effectiveness && <div><dt>Effectiveness</dt><dd>{effectiveness.mode === 'check' ? `Dedicated check by ${plantDate(effectiveness.checkDue ?? null)}: ${effectiveness.how}` : `Monitored through the trend and quality review: ${effectiveness.reason}`}</dd></div>}
          {result && <div><dt>Check result</dt><dd>{result.effective ? 'Effective' : 'Not effective'}: {result.note}</dd></div>}
        </dl>
        {c.signatures.map((s) => <p key={s.id} className="signature">✔ {MEANING_LABEL[s.meaning] ?? s.meaning} · {s.printedName} · {plantTime(s.signedAt)}</p>)}
      </section>

      {c.step === 'open' && ((c.ownerId === me.id && can(me, 'deviations.capa.complete')) || can(me, 'deviations.qa.oversee')) && (
        <form className="card form" onSubmit={done}>
          <h2>Mark as done</h2>
          <label>What was done (with record references)<textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="actions"><button className="primary" type="submit">Mark done</button></div>
        </form>
      )}

      {c.step === 'done' && verifier && (
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

      {c.step === 'check' && verifier && (
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

      {c.step === 'closed' && result && !result.effective && can(me, 'deviations.capa.raise') && (
        // D-63: while the QMS owns CAPA, the follow-up is raised in the QMS.
        qms.linked
          ? <div className="notice">This CAPA was not effective. {qms.off ? qms.note : <RaiseInQms q={qms} />}</div>
          : followUp
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
            const versionId = c.versions[c.versions.length - 1]!.id;
            if (signing === 'verify') await api('POST', `/api/capas/${id}/verify`, { effectiveness: effBody(), versionId, signature: cred });
            else await api('POST', `/api/capas/${id}/check`, { ...check, versionId, signature: cred });
            setSigning(null);
            await load();
          }} />
      )}
    </>
  );
}
