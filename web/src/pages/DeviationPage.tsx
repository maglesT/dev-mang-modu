import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { FISHBONE, Fishbone, emptyFishbone, hasFishbone } from '../components/Fishbone.js';
import { Signals } from '../components/Signals.js';
import { AiSuggest } from '../components/AiSuggest.js';
import {
  api, ApiError, CLASS_LABEL, MEANING_LABEL, plantDate, plantTime, STEP_CHIP, STEP_LABEL,
  type Deviation, type Me, type NamedItem, type SectionVersion,
} from '../api.js';
import { SignDialog } from '../components/SignDialog.js';
import { ReportForm, type ReportValues } from './ReportForm.js';
import { CapaTable, RaiseForm } from './Capas.js';
import type { CapaItem } from '../api.js';

interface Person { id: number; fullName: string; username: string }
type Kind = 'report' | 'classification' | 'investigation';
type SignKind = 'approved' | 'rejected' | 'resign' | 'closed' | 'reopened';

const latestOf = (d: Deviation, kind: SectionVersion['kind']) => d.sections.find((s) => s.kind === kind && s.latest);
const str = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : String(v));
const problemsOf = (err: unknown, fallback: string) =>
  err instanceof ApiError && err.problems.length ? err.problems : [err instanceof ApiError && err.code === 'invalid_request' ? fallback : (err as Error).message];

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
    case 'investigation': return `${d.investigator ?? 'The investigator'} investigates the root cause and signs the investigation.`;
    case 'closure': return 'QA raises CAPAs and closes the deviation.';
    case 'closed': return 'Closed.';
    case 'rejected': return 'Rejected: the planned deviation must not be carried out.';
  }
}

// DV-14: earlier versions stay readable, with who corrected them, when and why.
function Versions({ d, kind }: { d: Deviation; kind: Kind }) {
  const all = d.sections.filter((s) => s.kind === kind);
  if (all.length < 2) return null;
  const latest = all[all.length - 1]!;
  return (
    <details className="versions">
      <summary>Corrected · version {latest.version} by {latest.savedBy}, {plantTime(latest.savedAt)}: {latest.reason}</summary>
      {all.slice(0, -1).reverse().map((v) => (
        <div key={v.id} className="old-version">
          <b>Version {v.version}</b> · {v.savedBy} · {plantTime(v.savedAt)}{v.reason ? ` · reason: ${v.reason}` : ''}
          <Fields rows={Object.entries(v.data).flatMap(([k, x]): [string, ReactNode][] =>
            // The fishbone shows one line per category with text, as in the PDF (D-26).
            k === 'fishbone' && x && typeof x === 'object'
              ? FISHBONE.filter(([c]) => String((x as Record<string, unknown>)[c] ?? '').trim()).map(([c, label]) => [`fishbone: ${label}`, str((x as Record<string, unknown>)[c])])
              : [[k, typeof x === 'object' ? JSON.stringify(x) : str(x)]])} />
        </div>
      ))}
    </details>
  );
}

function Signatures({ d, kind }: { d: Deviation; kind: Kind }) {
  const ids = new Map(d.sections.filter((s) => s.kind === kind).map((s) => [s.id, s.latest]));
  return (
    <>
      {d.signatures.filter((s) => ids.has(s.sectionId)).map((s) => (
        <p key={s.id} className={ids.get(s.sectionId) ? 'signature' : 'signature superseded'}>
          {ids.get(s.sectionId) ? '✔' : '✖ Superseded by a correction:'} {MEANING_LABEL[s.meaning] ?? s.meaning} · {s.printedName} · {plantTime(s.signedAt)}
        </p>
      ))}
    </>
  );
}

export function DeviationPage({ me, id, onBack, onOpenCapa, onOpenDeviation }: { me: Me; id: number; onBack: () => void; onOpenCapa: (id: number) => void; onOpenDeviation: (id: number) => void }) {
  const [d, setD] = useState<Deviation | null>(null);
  const [signing, setSigning] = useState<SignKind | null>(null);
  const [correcting, setCorrecting] = useState<Kind | null>(null);
  const load = async () => setD(await api<Deviation>('GET', `/api/deviations/${id}`));
  useEffect(() => {
    void load();
  }, [id]);
  if (!d) return <p>Loading…</p>;

  const isQa = me.roles.includes('qa');
  const open = d.step !== 'closed' && d.step !== 'rejected';
  const report = latestOf(d, 'report')!.data as Record<string, unknown>;
  const classification = latestOf(d, 'classification');
  const investigation = latestOf(d, 'investigation');
  const own = d.batches.filter((b) => b.role === 'own');
  const other = d.batches.filter((b) => b.role === 'other');
  const isInvestigator = d.investigatorId === me.id || isQa;
  const can: Record<Kind, boolean> = {
    report: open && (d.reporterId === me.id || isQa),
    classification: open && !!classification && isQa && d.reporterId !== me.id,
    investigation: open && !!investigation && isInvestigator,
  };
  const correct = (kind: Kind) => async (data: object, reason: string) => {
    await api('POST', `/api/deviations/${d.id}/correct`, { kind, data, reason });
    setCorrecting(null);
    await load();
  };
  const correctButton = (kind: Kind) =>
    can[kind] && correcting !== kind && <button className="link small" onClick={() => setCorrecting(kind)}>Correct</button>;

  return (
    <>
      <button className="link" onClick={onBack}>← All deviations</button>
      <div className="home-head"><h1>{d.number} · {str(report.title)}</h1><a className="button" href={`/api/deviations/${d.id}/pdf`}>Print PDF</a></div>
      <div className={`statusbar ${d.overdue ? 'blocked' : 'fit'}`}>
        <span className={`chip ${STEP_CHIP[d.step]}`}>{STEP_LABEL[d.step]}</span>
        {d.classification && <span className="chip">{CLASS_LABEL[d.classification]}</span>}
        <span>Target date: <b>{plantDate(d.targetDate)}</b>{d.overdue && <span className="chip chip-bad">Overdue</span>}</span>
        <span className="next">Next: {nextAction(d)}</span>
      </div>

      <section className="card">
        <div className="section-head"><h2>1. Report{d.planned ? ' (planned deviation)' : ''}</h2>{correctButton('report')}</div>
        {correcting === 'report' ? (
          <ReportForm initial={report as unknown as ReportValues} correct={correct('report')} onDone={() => {}} onCancel={() => setCorrecting(null)} />
        ) : (
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
        )}
        <Versions d={d} kind="report" />
      </section>

      <section className="card">
        <div className="section-head"><h2>2. Classification</h2>{correctButton('classification')}</div>
        {classification && correcting !== 'classification' ? (
          <Classified d={d} c={classification} />
        ) : (classification && correcting === 'classification') || (d.step === 'classification' && isQa && d.reporterId !== me.id) ? (
          <ClassifyForm id={d.id} initial={classification?.data} correct={classification ? correct('classification') : undefined}
            onDone={async () => { setCorrecting(null); await load(); }} onCancel={() => setCorrecting(null)} />
        ) : (
          <p className="muted">{d.reporterId === me.id && isQa ? 'You reported this deviation, so another QA person classifies it.' : 'Waiting for QA.'}</p>
        )}
        <Versions d={d} kind="classification" />
        <Signatures d={d} kind="classification" />
        {d.step === 'approval' && isQa && d.reporterId !== me.id && (
          <div className="actions">
            <button onClick={() => setSigning('rejected')}>Reject</button>
            <button className="primary" onClick={() => setSigning('approved')}>Approve planned deviation</button>
          </div>
        )}
      </section>

      {d.step !== 'rejected' && <Signals id={d.id} onOpen={onOpenDeviation} />}

      <section className="card">
        <div className="section-head"><h2>3. Investigation</h2>{correctButton('investigation')}</div>
        {investigation && correcting !== 'investigation' ? (
          <>
          {hasFishbone(investigation.data.fishbone) && <Fishbone value={emptyFishbone(investigation.data.fishbone)} effect={str(report.title)} />}
          <Fields rows={[
            ['Root cause', <>{str(investigation.data.rootCause)}{investigation.data.mostLikely ? <span className="chip chip-warn">most likely cause; not confirmed</span> : null}</>],
            ...(investigation.data.humanError ? [['Human error', str(investigation.data.humanErrorJustification)] as [string, ReactNode]] : []),
            ['Other batches and products', other.length
              ? other.map((b) => `${b.product} / ${b.batch}: ${b.outcome === 'affected' ? 'affected' : 'not affected'}`).join('; ')
              : `None could be affected: ${str(investigation.data.noOtherReason)}`],
            ['Conclusion', str(investigation.data.conclusion)],
          ]} />
          </>
        ) : (investigation && correcting === 'investigation') || (d.step === 'investigation' && !investigation && isInvestigator) ? (
          <InvestigationForm d={d} initial={investigation?.data} correct={investigation ? correct('investigation') : undefined}
            onDone={async () => { setCorrecting(null); await load(); }} onCancel={() => setCorrecting(null)} />
        ) : (
          <p className="muted">{d.step === 'investigation' ? nextAction(d) : 'Follows classification.'}</p>
        )}
        <Versions d={d} kind="investigation" />
        <Signatures d={d} kind="investigation" />
        {d.investigationHash && isInvestigator && correcting !== 'investigation' && (
          <div className="actions"><button className="primary" onClick={() => setSigning('resign')}>Sign corrected investigation</button></div>
        )}
      </section>

      <Closure d={d} me={me} onOpenCapa={onOpenCapa} onChange={load} />

      <Attachments d={d} me={me} open={open} onChange={load} />

      <section className="card">
        <h2>History</h2>
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Reason</th></tr></thead>
          <tbody>
            {d.history.map((h) => (
              <tr key={h.id}><td>{plantTime(h.at)}</td><td>{h.actor ?? 'System'}</td><td>{h.action.replace('deviation.', '').replace('.', ' ').replaceAll('_', ' ')}</td><td>{h.reason}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      {(signing === 'approved' || signing === 'rejected') && (
        <ApproveDialog d={d} meaning={signing} onCancel={() => setSigning(null)} onDone={async () => { setSigning(null); await load(); }} />
      )}
      {signing === 'resign' && (
        <SignDialog meaning="investigation_complete" what={`${d.number}: the corrected investigation as shown.`} onCancel={() => setSigning(null)}
          onSign={async (cred) => {
            await api('POST', `/api/deviations/${d.id}/investigation/sign`, { ...cred, contentHash: d.investigationHash });
            setSigning(null);
            await load();
          }} />
      )}
    </>
  );
}

// DV-08, DV-10, D-14: CAPAs raised from the deviation, and QA's closure (open CAPAs do not block it).
function Closure({ d, me, onOpenCapa, onChange }: { d: Deviation; me: Me; onOpenCapa: (id: number) => void; onChange: () => Promise<void> }) {
  const [capas, setCapas] = useState<CapaItem[]>([]);
  const [raising, setRaising] = useState(false);
  const [f, setF] = useState({ summary: '', disposition: '', noCapaReason: '' });
  const [signing, setSigning] = useState<'closed' | 'reopened' | null>(null);
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => {
    void api<CapaItem[]>('GET', `/api/capas?deviationId=${d.id}&status=all`).then(setCapas);
  }, [d]);
  const isQa = me.roles.includes('qa');
  const closure = latestOf(d, 'closure');
  const canRaise = isQa && ['investigation', 'closure', 'closed'].includes(d.step);
  const noCapaAllowed = capas.length === 0 && d.classification === 'minor';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblems([]);
    if (!f.summary.trim()) return setProblems(['Write the closure summary.']);
    if (capas.length === 0 && d.classification !== 'minor') return setProblems(['A major or critical deviation needs at least one CAPA before closure.']);
    if (noCapaAllowed && !f.noCapaReason.trim()) return setProblems(['Raise a CAPA, or say why the immediate action was enough.']);
    setSigning('closed');
  };
  return (
    <section className="card">
      <h2>4. CAPAs and closure</h2>
      <CapaTable rows={capas} onOpen={onOpenCapa} showSource={false} />
      {canRaise && !raising && <div><button onClick={() => setRaising(true)}>Raise a CAPA</button></div>}
      {raising && <RaiseForm deviationId={d.id} onCancel={() => setRaising(false)} onDone={async () => { setRaising(false); setCapas(await api<CapaItem[]>('GET', `/api/capas?deviationId=${d.id}&status=all`)); }} />}
      {d.step === 'closed' && closure && (
        <Fields rows={[
          ['Closure summary', str(closure.data.summary)],
          ['Batch disposition', str(closure.data.disposition)],
          ...(closure.data.noCapaReason ? [['No CAPA because', str(closure.data.noCapaReason)] as [string, ReactNode]] : []),
          ['Open CAPAs', d.openCapas ? `${d.openCapas} still open (followed in the CAPA list)` : 'None'],
        ]} />
      )}
      <Signatures d={d} kind={'closure' as Kind} />
      {d.step === 'closure' && isQa && (
        <form className="form" onSubmit={submit}>
          <h3>Close the deviation</h3>
          <p className="muted small">Review the whole record and its history below before closing.</p>
          <label>Closure summary *<textarea rows={3} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></label>
          <label>Batch disposition notes<input value={f.disposition} onChange={(e) => setF({ ...f, disposition: e.target.value })} placeholder="e.g. Batch B123 may be released; see QA decision" /></label>
          {noCapaAllowed && <label>No CAPA: why the immediate action was enough *<input value={f.noCapaReason} onChange={(e) => setF({ ...f, noCapaReason: e.target.value })} /></label>}
          {problems.length > 0 && <div className="error">{problems.map((p) => <p key={p}>{p}</p>)}</div>}
          <div className="actions"><button className="primary" type="submit">Sign closed</button></div>
        </form>
      )}
      {d.step === 'closed' && isQa && <div className="actions"><button onClick={() => setSigning('reopened')}>Reopen</button></div>}
      {signing === 'closed' && (
        <SignDialog meaning="closed" what={`${d.number}: the deviation is reviewed and closed${d.openCapas || capas.some((c) => c.step !== 'closed') ? '; open CAPAs continue in the CAPA list' : ''}.`}
          onCancel={() => setSigning(null)}
          onSign={async (cred) => {
            await api('POST', `/api/deviations/${d.id}/close`, { data: f, signature: cred });
            setSigning(null);
            await onChange();
          }} />
      )}
      {signing === 'reopened' && (
        <SignDialog meaning="reopened" what={`${d.number}: reopen the deviation so it can be corrected.`} onCancel={() => setSigning(null)}
          onSign={async (cred) => {
            await api('POST', `/api/deviations/${d.id}/reopen`, { reason, signature: cred });
            setSigning(null);
            await onChange();
          }}>
          <label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        </SignDialog>
      )}
    </section>
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

function ReasonField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <label>Reason for the correction *<input value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}

function ClassifyForm({ id, initial, correct, onDone, onCancel }: {
  id: number; initial?: Record<string, unknown>; correct?: (data: object, reason: string) => Promise<void>; onDone: () => Promise<void>; onCancel: () => void;
}) {
  const [types, setTypes] = useState<NamedItem[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [f, setF] = useState({
    classification: String(initial?.classification ?? ''), typeId: Number(initial?.typeId ?? 0), impact: String(initial?.impact ?? ''),
    investigatorId: Number(initial?.investigatorId ?? 0), productBatchChecked: false,
  });
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => {
    void api<NamedItem[]>('GET', '/api/deviation-types').then((t) => setTypes(t.filter((x) => x.active)));
    void api<Person[]>('GET', '/api/people').then(setPeople);
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const data = { ...f, typeId: Number(f.typeId), investigatorId: Number(f.investigatorId) };
    try {
      if (correct) await correct(data, reason);
      else await api('POST', `/api/deviations/${id}/classify`, data);
      await onDone();
    } catch (err) {
      setProblems(problemsOf(err, correct && !reason.trim() ? 'Give the reason for the correction.' : 'Please fill in every field.'));
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
      {correct && <ReasonField value={reason} onChange={setReason} />}
      {problems.length > 0 && <div className="error">{problems.map((p) => <p key={p}>{p}</p>)}</div>}
      <div className="actions">
        {correct && <button type="button" onClick={onCancel}>Cancel</button>}
        <button className="primary" type="submit">{correct ? 'Save correction' : 'Save classification'}</button>
      </div>
    </form>
  );
}

type OtherRow = { product: string; batch: string; outcome: 'affected' | 'not_affected' };

function InvestigationForm({ d, initial, correct, onDone, onCancel }: {
  d: Deviation; initial?: Record<string, unknown>; correct?: (data: object, reason: string) => Promise<void>; onDone: () => Promise<void>; onCancel: () => void;
}) {
  const [f, setF] = useState({
    rootCause: String(initial?.rootCause ?? ''), mostLikely: Boolean(initial?.mostLikely), humanError: Boolean(initial?.humanError),
    humanErrorJustification: String(initial?.humanErrorJustification ?? ''), noOtherReason: String(initial?.noOtherReason ?? ''),
    conclusion: String(initial?.conclusion ?? ''),
  });
  const [fishbone, setFishbone] = useState(emptyFishbone(initial?.fishbone));
  const [rows, setRows] = useState<OtherRow[]>((initial?.otherBatches as OtherRow[] | undefined) ?? []);
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [signing, setSigning] = useState(false);
  const data = () => ({ ...f, fishbone, otherBatches: rows.filter((r) => r.product.trim() || r.batch.trim()) });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblems([]);
    if (!correct) return setSigning(true);
    try {
      await correct(data(), reason);
      await onDone();
    } catch (err) {
      setProblems(problemsOf(err, !reason.trim() ? 'Give the reason for the correction.' : 'Please fill in every field.'));
    }
  };
  const setRow = (i: number, patch: Partial<OtherRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
    <form className="form" onSubmit={submit}>
      <div>
        <b>Fishbone: possible causes considered</b>
        <p className="muted small">Optional. Note what was considered in each category, then state the root cause below.</p>
        <Fishbone value={fishbone} effect={str((latestOf(d, 'report')?.data as Record<string, unknown> | undefined)?.title)} onChange={setFishbone} />
        {!correct && <AiSuggest deviationId={d.id}
          onAdd={(k, text) => setFishbone((fb) => ({ ...fb, [k]: (fb[k].trim() ? `${fb[k].trim()}\n${text}` : text).slice(0, 2000) }))} />}
      </div>
      <label>Root cause *<textarea rows={4} value={f.rootCause} onChange={(e) => setF({ ...f, rootCause: e.target.value })} /></label>
      <label className="check"><input type="checkbox" checked={f.mostLikely} onChange={(e) => setF({ ...f, mostLikely: e.target.checked })} /> The true root cause could not be confirmed; the most likely cause is stated</label>
      <label className="check"><input type="checkbox" checked={f.humanError} onChange={(e) => setF({ ...f, humanError: e.target.checked })} /> The cause is human error</label>
      {f.humanError && <label>Why human error, and how process, procedure or system causes were ruled out *<textarea rows={3} value={f.humanErrorJustification} onChange={(e) => setF({ ...f, humanErrorJustification: e.target.value })} /></label>}
      <div>
        <b>Other batches and products checked *</b>
        <p className="muted small">List every other batch or product that may have been affected, even if already distributed, with the outcome.</p>
        {rows.map((r, i) => (
          <div className="row" key={i}>
            <input aria-label={`Other product ${i + 1}`} placeholder="Product" value={r.product} onChange={(e) => setRow(i, { product: e.target.value })} />
            <input aria-label={`Other batch ${i + 1}`} placeholder="Batch number" value={r.batch} onChange={(e) => setRow(i, { batch: e.target.value })} />
            <select aria-label={`Outcome ${i + 1}`} value={r.outcome} onChange={(e) => setRow(i, { outcome: e.target.value as OtherRow['outcome'] })}>
              <option value="not_affected">Not affected</option>
              <option value="affected">Affected</option>
            </select>
            <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button type="button" onClick={() => setRows([...rows, { product: '', batch: '', outcome: 'not_affected' }])}>Add a batch checked</button>
        {rows.length === 0 && <label>Or: why no other batch or product could be affected<input value={f.noOtherReason} onChange={(e) => setF({ ...f, noOtherReason: e.target.value })} /></label>}
      </div>
      <label>Conclusion *<textarea rows={3} value={f.conclusion} onChange={(e) => setF({ ...f, conclusion: e.target.value })} /></label>
      {correct && <ReasonField value={reason} onChange={setReason} />}
      {problems.length > 0 && <div className="error">{problems.map((p) => <p key={p}>{p}</p>)}</div>}
      <div className="actions">
        {correct && <button type="button" onClick={onCancel}>Cancel</button>}
        <button className="primary" type="submit">{correct ? 'Save correction' : 'Sign investigation complete'}</button>
      </div>
    </form>
      {/* Outside the form: a nested form would submit the page. */}
      {signing && (
        <SignDialog meaning="investigation_complete" what={`${d.number}: the investigation as entered on this page.`} onCancel={() => setSigning(false)}
          onSign={async (cred) => {
            await api('POST', `/api/deviations/${d.id}/investigate`, { data: data(), signature: cred });
            setSigning(false);
            await onDone();
          }} />
      )}
    </>
  );
}

function Attachments({ d, me, open, onChange }: { d: Deviation; me: Me; open: boolean; onChange: () => Promise<void> }) {
  const [error, setError] = useState('');
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (file.size > 10 * 1024 * 1024) return setError('Files can be at most 10 MB.');
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    try {
      await api('POST', `/api/deviations/${d.id}/attachments`, { filename: file.name, mime: file.type, dataBase64: btoa(bin) });
      await onChange();
    } catch {
      setError('Only PDF, PNG or JPEG files up to 10 MB can be attached.');
    }
  };
  const withdraw = async (attachmentId: number) => {
    const reason = window.prompt('Reason for withdrawing this file (it stays in the record):')?.trim();
    if (!reason) return;
    try {
      await api('POST', `/api/attachments/${attachmentId}/withdraw`, { reason });
      await onChange();
    } catch {
      setError('Only the person who attached the file or QA can withdraw it.');
    }
  };
  const canAct = open && !me.roles.includes('admin');
  return (
    <section className="card">
      <h2>Attachments</h2>
      {d.attachments.length === 0 && <p className="muted">No files.</p>}
      <ul className="plain">
        {d.attachments.map((a) => (
          <li key={a.id}>
            {a.withdrawnAt ? <s>{a.filename}</s> : <a href={`/api/attachments/${a.id}`}>{a.filename}</a>}
            <span className="muted"> · {Math.ceil(a.size / 1024)} KB · {a.uploadedBy} · {plantTime(a.uploadedAt)}</span>
            {a.withdrawnAt ? <span className="muted"> · withdrawn: {a.withdrawnReason}</span>
              : canAct && (a.uploaderId === me.id || me.roles.includes('qa')) && <button className="link small" onClick={() => withdraw(a.id)}>Withdraw</button>}
          </li>
        ))}
      </ul>
      {canAct && <label className="upload">Attach a file (PDF, PNG, JPEG, up to 10 MB)<input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => void upload(e.target.files?.[0])} /></label>}
      {error && <p className="error">{error}</p>}
    </section>
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
