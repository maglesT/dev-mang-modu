import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, localInputValue, type NamedItem } from '../api.js';

// DV-01: one short form for everyone. The number is given at once on saving.
export function ReportForm({ onDone, onCancel }: { onDone: (id: number) => void; onCancel: () => void }) {
  const [areas, setAreas] = useState<NamedItem[]>([]);
  const [f, setF] = useState({
    planned: false, title: '', description: '', areaId: 0, equipment: '', eventAt: localInputValue(),
    immediateAction: '', plannedReason: '', noBatch: false,
  });
  const [products, setProducts] = useState([{ product: '', batch: '' }]);
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
      const res = await api<{ id: number; number: string }>('POST', '/api/deviations', {
        ...f, areaId: Number(f.areaId), eventAt: new Date(f.eventAt).toISOString(), products: rows,
      });
      onDone(res.id);
    } catch (err) {
      setProblems(err instanceof ApiError && err.problems.length ? err.problems : ['Please fill in every field marked *.']);
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h1>Report a deviation</h1>
      <fieldset className="choice">
        <label className="check"><input type="radio" checked={!f.planned} onChange={() => setF({ ...f, planned: false })} /> It has happened (unplanned)</label>
        <label className="check"><input type="radio" checked={f.planned} onChange={() => setF({ ...f, planned: true })} /> It is planned (needs QA approval first)</label>
      </fieldset>
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
      {problems.length > 0 && <div className="error">{problems.map((p) => <p key={p}>{p}</p>)}</div>}
      <div className="actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" type="submit" disabled={busy}>Save and get a number</button>
      </div>
    </form>
  );
}
