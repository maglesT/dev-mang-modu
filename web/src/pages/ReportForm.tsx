import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, localInputValue, type NamedItem } from '../api.js';

export interface ReportValues {
  planned: boolean; title: string; description: string; areaId: number; equipment: string; eventAt: string;
  immediateAction: string; plannedReason: string; noBatch: boolean; products: { product: string; batch: string }[];
}

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
    ? { ...initial, eventAt: localInputValue(new Date(initial.eventAt)) }
    : { planned: false, title: '', description: '', areaId: 0, equipment: '', eventAt: localInputValue(), immediateAction: '', plannedReason: '', noBatch: false });
  const [products, setProducts] = useState(initial?.products.length ? initial.products : [{ product: '', batch: '' }]);
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<NamedItem[]>('GET', '/api/areas').then((a) => setAreas(a.filter((x) => x.active)));
  }, []);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblems([]);
    try {
      const rows = f.noBatch ? [] : products.filter((p) => p.product.trim() || p.batch.trim());
      const { products: _ignored, ...rest } = f as typeof f & { products?: unknown };
      const data = { ...rest, areaId: Number(f.areaId), eventAt: new Date(f.eventAt).toISOString(), products: rows };
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
      {!correct && <fieldset className="choice">
        <label className="check"><input type="radio" checked={!f.planned} onChange={() => setF({ ...f, planned: false })} /> It has happened (unplanned)</label>
        <label className="check"><input type="radio" checked={f.planned} onChange={() => setF({ ...f, planned: true })} /> It is planned (needs QA approval first)</label>
      </fieldset>}
      <label>Title *<input value={f.title} onChange={set('title')} placeholder="Short description, e.g. Mixer stopped during granulation" /></label>
      <label>What happened *<textarea rows={4} value={f.description} onChange={set('description')} /></label>
      {f.planned && <label>Reason for the planned deviation *<textarea rows={3} value={f.plannedReason} onChange={set('plannedReason')} /></label>}
      <div className="grid2">
        <label>Area *
          <select value={f.areaId} onChange={set('areaId')}>
            <option value={0}>Choose…</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label>Equipment (optional)<input value={f.equipment} onChange={set('equipment')} placeholder="e.g. RMG-01" /></label>
        <label>{f.planned ? 'Planned for *' : 'When it happened *'}<input type="datetime-local" value={f.eventAt} onChange={set('eventAt')} /></label>
      </div>
      <div>
        <b>Product and batch *</b>
        {!f.noBatch && products.map((p, i) => (
          <div className="row" key={i}>
            <input aria-label={`Product ${i + 1}`} placeholder="Product" value={p.product} onChange={(e) => setProducts(products.map((x, j) => (j === i ? { ...x, product: e.target.value } : x)))} />
            <input aria-label={`Batch ${i + 1}`} placeholder="Batch number" value={p.batch} onChange={(e) => setProducts(products.map((x, j) => (j === i ? { ...x, batch: e.target.value } : x)))} />
            {products.length > 1 && <button type="button" onClick={() => setProducts(products.filter((_, j) => j !== i))}>Remove</button>}
          </div>
        ))}
        {!f.noBatch && <button type="button" onClick={() => setProducts([...products, { product: '', batch: '' }])}>Add another batch</button>}
        <label className="check"><input type="checkbox" checked={f.noBatch} onChange={(e) => setF({ ...f, noBatch: e.target.checked })} /> No product or batch concerned (e.g. a facility event)</label>
      </div>
      <label>Immediate action taken *<textarea rows={3} value={f.immediateAction} onChange={set('immediateAction')} /></label>
      {correct && <label>Reason for the correction *<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      {problems.length > 0 && <div className="error">{problems.map((p) => <p key={p}>{p}</p>)}</div>}
      <div className="actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" type="submit" disabled={busy}>{correct ? 'Save correction' : 'Save and get a number'}</button>
      </div>
    </form>
  );
}
