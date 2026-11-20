import { oosItemWords, oosLotWord } from '../../../server/words.js';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, localInputValue, type NamedItem } from '../api.js';

export type Answer = '' | 'yes' | 'no' | 'unknown';
export interface InitialImpact { productQuality: Answer; patientSafety: Answer; otherBatches: Answer; notes: string }
export interface ReportValues {
  planned: boolean; title: string; description: string; areaId?: number; equipment: string; eventAt: string;
  immediateAction: string; actionTakenAt?: string | null; initialImpact?: InitialImpact;
  plannedReason: string; noBatch: boolean; products: ProductRow[]; oos?: Oos;
}
// D-60: an OOS of LIMS, as LIMS publishes it (oos_v1); the report keeps it as read when filed.
export interface Oos {
  id: string; number: string; sample: string; lot: string; itemKind: string; itemCode: string; itemName: string;
  analysis: string; test: string; result: string; limit: string; phaseI: string; openedAt: string;
}
interface OosPick extends Oos { status: string; phaseII: boolean; filed: string | null }
// D-61: an OOS report is filed in the QC laboratory area, set by the server (made the first time); not chosen here.
export const LIMS_AREA = 'QC laboratory (Medhanta LIMS)';
const oosItem = (o: Oos) => oosItemWords(o);
export const oosText = (o: Oos) =>
  `${o.number}: ${o.test} of ${oosItem(o)}, ${oosLotWord(o.itemKind)} ${o.lot}; result ${o.result}, limit ${o.limit}`;
// D-57: a batch picked from a linked TrueBatch product names it (`from`); without it the batch was typed by hand.
export interface ProductRow { product: string; batch: string; from?: string }
interface BatchPick { batch: string; product: string | null; productName: string | null; status: string | null; from: string }
const statusText = (x: string | null) => (x ? x.toLowerCase().replace(/_/g, ' ') : '');
export const ANSWER_LABEL: Record<string, string> = { yes: 'Yes', no: 'No', unknown: 'Not known yet' };
const IMPACT_QUESTIONS: [keyof Omit<InitialImpact, 'notes'>, string][] = [
  ['productQuality', 'Could product quality be affected?'],
  ['patientSafety', 'Could patient safety be at risk?'],
  ['otherBatches', 'Could other batches be affected?'],
];
const noImpact: InitialImpact = { productQuality: '', patientSafety: '', otherBatches: '', notes: '' };

// DV-01: one short form for everyone. The number is given at once on saving.
// With `correct`, the same form corrects a saved report (DV-14): a reason is required.
export function ReportForm({ onDone, onCancel, initial, correct }: {
  onDone: (id: number) => void;
  onCancel: () => void;
  initial?: ReportValues;
  correct?: (data: object, reason: string) => Promise<void>;
}) {
  const [areas, setAreas] = useState<NamedItem[]>([]);
  const [f, setF] = useState(initial
    ? { ...initial, areaId: initial.areaId ?? 0, eventAt: localInputValue(new Date(initial.eventAt)), actionTakenAt: initial.actionTakenAt ? localInputValue(new Date(initial.actionTakenAt)) : '' }
    : { planned: false, title: '', description: '', areaId: 0, equipment: '', eventAt: localInputValue(), immediateAction: '', actionTakenAt: '', plannedReason: '', noBatch: false });
  const [impact, setImpact] = useState<InitialImpact>(initial?.initialImpact ?? noImpact);
  const [products, setProducts] = useState<ProductRow[]>(initial?.products.length ? initial.products : [{ product: '', batch: '' }]);
  // D-57: the batches of the linked TrueBatch products (none listed when no product is linked or the list cannot be read).
  const [picks, setPicks] = useState<{ batches: BatchPick[]; notes: string[] }>({ batches: [], notes: [] });
  // D-60: the open OOS of LIMS (only when LIMS is linked); a picked OOS fills the report and is kept with it.
  const [oosList, setOosList] = useState<{ linked: boolean; oos: OosPick[]; note: string | null }>({ linked: false, oos: [], note: null });
  const [oos, setOos] = useState<Oos | undefined>(initial?.oos);
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<NamedItem[]>('GET', '/api/areas').then((a) => setAreas(a.filter((x) => x.active)));
    void api<{ batches: BatchPick[]; notes: string[] }>('GET', '/api/batches').then(setPicks).catch(() => {});
    if (!correct) void api<typeof oosList>('GET', '/api/oos').then(setOosList).catch(() => {});
  }, []);
  // D-60: picking an OOS fills the title, what happened, when and its lot (product and lot pulled, not typed).
  const pickOos = (id: string) => {
    const o = oosList.oos.find((x) => x.id === id);
    const others = products.filter((p) => p.from !== 'lims' && (p.batch.trim() || p.product.trim()));
    if (!o) {
      setOos(undefined);
      setProducts(others.length ? others : [{ product: '', batch: '' }]);
      return;
    }
    setOos(o);
    setF({ ...f, planned: false, noBatch: false, eventAt: localInputValue(new Date(o.openedAt)),
      title: `${o.number} phase II: ${o.test} of ${oosItem(o)}, ${oosLotWord(o.itemKind)} ${o.lot}`.slice(0, 200),
      description: `Phase II investigation of LIMS OOS ${o.number}. ${o.test} of ${oosItem(o)}, ${oosLotWord(o.itemKind)} ${o.lot}, sample ${o.sample}, analysis ${o.analysis}: `
        + `result ${o.result}, limit ${o.limit}. ${o.phaseI}` });
    setProducts([{ product: o.itemCode || o.itemName, batch: o.lot || o.sample, from: 'lims' }, ...others]);
  };
  // A batch from the list brings its product; any other text is a batch typed by hand (the product is then typed too).
  const setBatch = (i: number, value: string) => {
    const pick = picks.batches.find((b) => b.batch === value);
    setProducts(products.map((x, j) => (j !== i ? x
      : pick ? { product: pick.product ?? pick.productName ?? '', batch: pick.batch, from: pick.from }
      : { product: x.from ? '' : x.product, batch: value })));
  };

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblems([]);
    try {
      const rows = f.noBatch ? [] : products.filter((p) => p.product.trim() || p.batch.trim());
      const { products: _ignored, ...rest } = f as typeof f & { products?: unknown };
      const data = {
        ...rest, areaId: oos && !correct ? undefined : Number(f.areaId), eventAt: new Date(f.eventAt).toISOString(), products: rows,
        actionTakenAt: f.actionTakenAt ? new Date(f.actionTakenAt).toISOString() : null, initialImpact: impact,
        ...(oos ? { oos: correct ? oos : { id: oos.id } } : {}),
      };
      if (correct) {
        await correct(data, reason);
        onDone(0);
        return;
      }
      const res = await api<{ id: number; number: string }>('POST', '/api/deviations', data);
      onDone(res.id);
    } catch (err) {
      setProblems(err instanceof ApiError && err.problems.length ? err.problems : [correct && !reason.trim() ? 'Give the reason for the correction.' : 'Please fill in every field marked *.']);
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      {correct ? <h2>Correct the report</h2> : <h1>Report a deviation</h1>}
      {!correct && oosList.linked && (
        <div>
          <label>OOS from LIMS (phase II investigation)
            <select className="fit" value={oos?.id ?? ''} onChange={(e) => pickOos(e.target.value)}>
              <option value="">None: not an OOS</option>
              {oosList.oos.map((o) => (
                <option key={o.id} value={o.id} disabled={!o.phaseII || !!o.filed}>
                  {`${oosText(o)}${o.filed ? ` · already has ${o.filed}` : !o.phaseII ? ' · phase I not finished' : ''}`}
                </option>
              ))}
            </select>
          </label>
          {oosList.note && <p className="muted small">{oosList.note}</p>}
          {!oosList.note && <p className="muted small">The open OOS of LIMS. Pick one whose phase I found no laboratory error; its details come from LIMS. An OOS that already has a deviation cannot be picked again.</p>}
        </div>
      )}
      {oos && <p className="small"><b>LIMS OOS {oos.number}</b> · {oos.test} · {oosItem(oos)} · {oosLotWord(oos.itemKind)} {oos.lot} · result {oos.result} · limit {oos.limit} · {oos.phaseI}</p>}
      {!correct && <fieldset className="choice">
        <label className="check"><input type="radio" checked={!f.planned} onChange={() => setF({ ...f, planned: false })} /> It has happened (unplanned)</label>
        <label className="check"><input type="radio" checked={f.planned} disabled={!!oos} onChange={() => setF({ ...f, planned: true })} /> It is planned (needs QA approval first)</label>
      </fieldset>}
      <label>Title *<input value={f.title} onChange={set('title')} placeholder="Short description, e.g. Mixer stopped during granulation" /></label>
      <label>What happened *<textarea rows={4} value={f.description} onChange={set('description')} /></label>
      {f.planned && <label>Reason for the planned deviation *<textarea rows={3} value={f.plannedReason} onChange={set('plannedReason')} /></label>}
      <div className="grid2">
        {oos ? (
          <label>Area *
            <input readOnly value={correct ? (areas.find((a) => a.id === Number(f.areaId))?.name ?? LIMS_AREA) : LIMS_AREA} title="An OOS is a QC laboratory deviation: the area is set, not chosen." />
          </label>
        ) : (
          <label>Area *
            <select value={f.areaId} onChange={set('areaId')}>
              <option value={0}>Choose…</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
        <label>Equipment (optional)<input value={f.equipment} onChange={set('equipment')} placeholder="e.g. RMG-01" /></label>
        <label>{f.planned ? 'Planned for *' : 'When it happened *'}<input type="datetime-local" value={f.eventAt} onChange={set('eventAt')} /></label>
      </div>
      <div>
        <b>Product and batch *</b>
        {!f.noBatch && picks.batches.length > 0 && <p className="muted small">Pick the batch from the list; its product comes with it. A batch not in the list may be typed: it is saved as typed by hand.</p>}
        {!f.noBatch && picks.notes.map((n) => <p className="muted small" key={n}>{n}</p>)}
        <datalist id="batch-picks">
          {picks.batches.map((b) => <option key={`${b.from}:${b.batch}`} value={b.batch}>{[b.product, b.productName, statusText(b.status)].filter(Boolean).join(' · ')}</option>)}
        </datalist>
        {!f.noBatch && products.map((p, i) => (
          <div className="row" key={i}>
            <input aria-label={`Batch ${i + 1}`} placeholder={picks.batches.length ? 'Pick or type the batch number' : 'Batch number'} list="batch-picks" value={p.batch}
              readOnly={p.from === 'lims'} title={p.from === 'lims' ? `The ${oos ? oosLotWord(oos.itemKind) : 'lot'} of the OOS, from LIMS` : undefined} onChange={(e) => setBatch(i, e.target.value)} />
            <input aria-label={`Product ${i + 1}`} placeholder="Product" value={p.product} readOnly={!!p.from} title={p.from === 'lims' ? 'From the OOS in LIMS' : p.from ? 'From the picked batch' : undefined}
              onChange={(e) => setProducts(products.map((x, j) => (j === i ? { ...x, product: e.target.value } : x)))} />
            {p.batch.trim() && !p.from && <span className="chip chip-warn">Typed by hand</span>}
            {p.from === 'lims' && <span className="chip">From LIMS OOS</span>}
            {p.from === 'ops' && <span className="chip">From Operations CPV</span>}
            {products.length > 1 && p.from !== 'lims' && <button type="button" onClick={() => setProducts(products.filter((_, j) => j !== i))}>Remove</button>}
          </div>
        ))}
        {!f.noBatch && <button type="button" onClick={() => setProducts([...products, { product: '', batch: '' }])}>Add another batch</button>}
        <label className="check"><input type="checkbox" checked={f.noBatch} disabled={!!oos} onChange={(e) => setF({ ...f, noBatch: e.target.checked })} /> No product or batch concerned (e.g. a facility event)</label>
      </div>
      <fieldset className="impact">
        <legend><b>Initial impact assessment *</b> <span className="muted small">Your first view; QA assesses it again when classifying.</span></legend>
        {IMPACT_QUESTIONS.map(([k, q]) => (
          <div className="row" key={k} role="radiogroup" aria-label={q}>
            <span className="q">{q}</span>
            {(['yes', 'no', 'unknown'] as const).map((a) => (
              <label className="check" key={a}><input type="radio" name={k} checked={impact[k] === a} onChange={() => setImpact({ ...impact, [k]: a })} /> {ANSWER_LABEL[a]}</label>
            ))}
          </div>
        ))}
        <label>Short assessment *<textarea rows={2} value={impact.notes} onChange={(e) => setImpact({ ...impact, notes: e.target.value })} placeholder="e.g. Tablets made since 14:00 may be soft; batch on hold." /></label>
      </fieldset>
      <div className="grid2">
        <label>Action taken (immediate action) *<textarea rows={3} value={f.immediateAction} onChange={set('immediateAction')} /></label>
        <label>When the action was taken<input type="datetime-local" value={f.actionTakenAt ?? ''} onChange={set('actionTakenAt')} /></label>
      </div>
      {correct && <label>Reason for the correction *<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      {problems.length > 0 && <div className="error">{problems.map((p) => <p key={p}>{p}</p>)}</div>}
      <div className="actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" type="submit" disabled={busy}>{correct ? 'Save correction' : 'Save and get a number'}</button>
      </div>
    </form>
  );
}
