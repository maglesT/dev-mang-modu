import { useState, type FormEvent } from 'react';
import { api, ApiError, CLASS_LABEL, plantDate, SOURCE_LABEL, STEP_CHIP, STEP_LABEL, type Step } from '../api.js';

interface LookupRow {
  id: number; number: string; step: Step; classification: string | null; targetDate: string | null; title: string;
  role: 'own' | 'other'; product: string; batch: string; outcome: string | null; open: boolean; openCapas: number;
}
interface Trends {
  from: string; to: string; by: string;
  counts: { key: string; month: string; n: number }[];
  products: { product: string; n: number }[];
  capas: { source: string; step: string; outcome: string; n: number }[];
  // S10 (D-30): months above their own usual level (key null = all deviations).
  spikes: { key: string | null; month: string; n: number; mean: number; limit: number }[];
}

const monthNow = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
const monthsBetween = (from: string, to: string) => {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  while (`${y}-${String(m).padStart(2, '0')}` <= to) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
};
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const OUTCOME: Record<string, string> = { effective: 'Effective', not_effective: 'Not effective', trend: 'Monitored by trend/review', pending: 'Not yet assessed' };

// DV-11 and DV-12: "affects batch X" and the simple trend view, on one screen.
export function BatchTrends({ onOpen }: { onOpen: (id: number) => void }) {
  return (
    <>
      <h1>Batch check and trends</h1>
      <BatchLookup onOpen={onOpen} />
      <TrendView />
    </>
  );
}

function BatchLookup({ onOpen }: { onOpen: (id: number) => void }) {
  const [batch, setBatch] = useState('');
  const [rows, setRows] = useState<LookupRow[] | null>(null);
  const [error, setError] = useState('');
  const search = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      setRows(await api<LookupRow[]>('GET', `/api/batch-lookup?batch=${encodeURIComponent(batch)}`));
    } catch (err) {
      setError(err instanceof ApiError && err.problems.length ? err.problems.join(' ') : 'Type a batch number.');
    }
  };
  const open = rows?.filter((r) => r.open).length ?? 0;
  return (
    <section className="card">
      <h2>Deviations affecting a batch</h2>
      <form className="row" onSubmit={search}>
        <input aria-label="Batch number" placeholder="Batch number, e.g. PCM-2401" value={batch} onChange={(e) => setBatch(e.target.value)} />
        <button className="primary" type="submit">Check batch</button>
      </form>
      {error && <p className="error">{error}</p>}
      {rows && (rows.length === 0
        ? <p className="notice ok-notice">No deviation names this batch.</p>
        : <>
            <p className={open ? 'notice' : 'notice ok-notice'}>{open ? `${open} open deviation${open > 1 ? 's concern' : ' concerns'} this batch. Take them into account before release.` : 'All deviations naming this batch are closed.'}</p>
            <table className="list">
              <thead><tr><th>Number</th><th>Title</th><th>How the batch is named</th><th>Class</th><th>Status</th><th>Target date</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.id}-${r.role}-${r.batch}`} className="click" onClick={() => onOpen(r.id)}>
                    <td><button className="link">{r.number}</button></td>
                    <td>{r.title}</td>
                    <td>{r.role === 'own' ? `Concerned: ${r.product} / ${r.batch}` : `Other batch checked: ${r.product} / ${r.batch} (${r.outcome === 'affected' ? 'affected' : 'not affected'})`}</td>
                    <td>{r.classification ? CLASS_LABEL[r.classification] : '—'}</td>
                    <td><span className={`chip ${STEP_CHIP[r.step]}`}>{STEP_LABEL[r.step]}</span>{r.openCapas > 0 && <span className="chip">{r.openCapas} CAPA open</span>}</td>
                    <td>{plantDate(r.targetDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>)}
    </section>
  );
}

function TrendView() {
  const now = monthNow();
  const yearAgo = `${Number(now.slice(0, 4)) - 1}-${now.slice(5)}`;
  const [f, setF] = useState({ from: yearAgo, to: now, by: 'area', product: '' });
  const [data, setData] = useState<Trends | null>(null);
  const [error, setError] = useState('');
  const load = async (e?: FormEvent) => {
    e?.preventDefault();
    setError('');
    try {
      setData(await api<Trends>('GET', `/api/trends?${new URLSearchParams(f)}`));
    } catch (err) {
      setError(err instanceof ApiError && err.problems.length ? err.problems.join(' ') : 'Choose a valid period.');
    }
  };
  const months = data ? monthsBetween(data.from, data.to) : [];
  const keys = data ? [...new Set(data.counts.map((c) => c.key))].sort() : [];
  const cell = (key: string, m: string) => data?.counts.find((c) => c.key === key && c.month === m)?.n ?? 0;
  const totals = months.map((m) => data?.counts.filter((c) => c.month === m).reduce((s, c) => s + c.n, 0) ?? 0);
  const keyLabel = (k: string) => (data?.by === 'classification' ? CLASS_LABEL[k] ?? k : k);
  const spike = (key: string | null, m: string) => data?.spikes.find((x) => x.key === key && x.month === m);
  const td = (key: string | null, m: string, n: number) => {
    const x = spike(key, m);
    return <td key={m} className={x ? 'spike' : undefined} title={x ? `Above the usual level: about ${x.mean} a month, limit ${x.limit}` : undefined}>{n || ''}{x ? ' ▲' : ''}</td>;
  };
  const sum = (pick: (c: Trends['capas'][number]) => string) =>
    Object.entries((data?.capas ?? []).reduce<Record<string, number>>((acc, c) => ({ ...acc, [pick(c)]: (acc[pick(c)] ?? 0) + c.n }), {}));

  return (
    <section className="card">
      <h2>Trend</h2>
      <form className="row filters" onSubmit={load}>
        <label>From<input type="month" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label>To<input type="month" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <label>Split by<select value={f.by} onChange={(e) => setF({ ...f, by: e.target.value })}>
          <option value="area">Area</option><option value="type">Type</option><option value="classification">Classification</option>
        </select></label>
        <label>Product<input placeholder="any" value={f.product} onChange={(e) => setF({ ...f, product: e.target.value })} /></label>
        <button className="primary" type="submit">Show</button>
        <button type="button" onClick={() => window.print()}>Print</button>
      </form>
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          {data.products.length > 0 && (
            <p className="muted small">Product spellings included: {data.products.map((p) => `${p.product} (${p.n})`).join(' · ')}</p>
          )}
          <MonthBars months={months} totals={totals} />
          <div className="scroll"><table className="trend">
            <thead><tr><th>{data.by === 'area' ? 'Area' : data.by === 'type' ? 'Type' : 'Classification'}</th>{months.map((m) => <th key={m}>{monthLabel(m)}</th>)}<th>Total</th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k}><td>{keyLabel(k)}</td>{months.map((m) => td(k, m, cell(k, m)))}<td><b>{months.reduce((s, m) => s + cell(k, m), 0)}</b></td></tr>
              ))}
              <tr className="total"><td>All deviations</td>{totals.map((n, i) => td(null, months[i]!, n))}<td><b>{totals.reduce((s, n) => s + n, 0)}</b></td></tr>
            </tbody>
          </table></div>
          <div className="spikes" role="region" aria-label="Unusual months">
            <h3>Unusual months</h3>
            {data.spikes.length === 0 ? <p className="muted small">No month is above its usual level.</p> : (
              <ul>{data.spikes.map((x) => (
                <li key={`${x.key}-${x.month}`}><b>{x.key === null ? 'All deviations' : keyLabel(x.key)}, {monthLabel(x.month)}:</b> {x.n} deviations; usually about {x.mean} a month. Worth a look: what changed that month?</li>
              ))}</ul>
            )}
            <p className="muted small">How it works: a month is marked ▲ when its count is above the average of the 12 months before it plus 3 × the square root of that average (a c-chart limit). It needs at least 6 earlier months and at least 3 deviations. A mark is a reason to look, not a conclusion.</p>
          </div>
          <h3>CAPAs raised in the period</h3>
          <div className="grid3">
            <table><thead><tr><th>Source</th><th>Count</th></tr></thead><tbody>{sum((c) => SOURCE_LABEL[c.source] ?? c.source).map(([k, n]) => <tr key={k}><td>{k}</td><td>{n}</td></tr>)}</tbody></table>
            <table><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>{sum((c) => (c.step === 'closed' ? 'Closed' : 'Not closed')).map(([k, n]) => <tr key={k}><td>{k}</td><td>{n}</td></tr>)}</tbody></table>
            <table><thead><tr><th>Effectiveness</th><th>Count</th></tr></thead><tbody>{sum((c) => OUTCOME[c.outcome] ?? c.outcome).map(([k, n]) => <tr key={k}><td>{k}</td><td>{n}</td></tr>)}</tbody></table>
          </div>
        </>
      )}
    </section>
  );
}

// One series (deviations per month): one hue, thin bars rounded at the data end, baseline-anchored,
// recessive axis, a hover tooltip per bar. The table below is the accessible view of the same numbers.
function MonthBars({ months, totals }: { months: string[]; totals: number[] }) {
  const max = Math.max(1, ...totals);
  const W = 720, H = 160, pad = 24, slot = (W - pad) / Math.max(1, months.length), bar = Math.min(28, slot * 0.6);
  return (
    <svg className="bars" viewBox={`0 0 ${W} ${H + 22}`} role="img" aria-label="Deviations reported per month">
      <line x1={pad} x2={W} y1={H} y2={H} className="axis" />
      <text x={0} y={12} className="tick">{max}</text>
      <text x={0} y={H} className="tick">0</text>
      {months.map((m, i) => {
        const h = (totals[i]! / max) * (H - 16);
        const x = pad + i * slot + (slot - bar) / 2;
        return (
          <g key={m} className="bar">
            <rect x={pad + i * slot} y={0} width={slot} height={H} className="hit"><title>{`${monthLabel(m)}: ${totals[i]} deviation${totals[i] === 1 ? '' : 's'}`}</title></rect>
            {h > 0 && <path d={`M${x},${H} V${H - h + 4} q0,-4 4,-4 h${bar - 8} q4,0 4,4 V${H} Z`} className="mark" />}
            <text x={pad + i * slot + slot / 2} y={H + 16} className="tick" textAnchor="middle">{monthLabel(m)}</text>
          </g>
        );
      })}
    </svg>
  );
}
