import { useEffect, useState, type FormEvent } from 'react';
import { api, CLASS_LABEL, plantDate, STEP_CHIP, STEP_LABEL, type DeviationItem, type Me } from '../api.js';

type View = 'mine' | 'open' | 'overdue' | 'all';
const VIEWS: [View, string][] = [['mine', 'Waiting for me'], ['open', 'Open'], ['overdue', 'Overdue'], ['all', 'All']];

// Home: the next action is obvious (report button, "waiting for me"), with status and due dates at a glance.
export function Home({ me, onReport, onOpen, onCapas }: { me: Me; onReport: () => void; onOpen: (id: number) => void; onCapas: () => void }) {
  const [myCapas, setMyCapas] = useState(0);
  const [view, setView] = useState<View>('mine');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<DeviationItem[]>([]);
  const [counts, setCounts] = useState<Record<View, number>>({ mine: 0, open: 0, overdue: 0, all: 0 });
  const canReport = me.roles.includes('user') || me.roles.includes('qa');

  const load = async (v = view, search = q) => {
    const params = new URLSearchParams({ view: search ? 'all' : v, ...(search ? { q: search } : {}) });
    setRows(await api<DeviationItem[]>('GET', `/api/deviations?${params}`));
  };
  useEffect(() => {
    void api<unknown[]>('GET', '/api/capas?mine=1').then((r) => setMyCapas(r.length));
    void load();
    void Promise.all((['mine', 'open', 'overdue'] as View[]).map(async (v) => [v, (await api<DeviationItem[]>('GET', `/api/deviations?view=${v}`)).length] as const))
      .then((c) => setCounts((old) => ({ ...old, ...Object.fromEntries(c) })));
  }, []);

  const pick = (v: View) => {
    setView(v);
    setQ('');
    void load(v, '');
  };
  const search = (e: FormEvent) => {
    e.preventDefault();
    void load(view, q.trim());
  };

  return (
    <>
      <div className="home-head">
        <h1>Deviations</h1>
        {canReport && <button className="primary big" onClick={onReport}>Report a deviation</button>}
      </div>
      <div className="stats">
        <div className="stat info"><b>{counts.mine}</b><span>Waiting for me</span></div>
        <div className="stat bad"><b>{counts.overdue}</b><span>Overdue</span></div>
        <div className="stat"><b>{counts.open}</b><span>Open</span></div>
        <button className="stat info stat-link" onClick={onCapas}><b>{myCapas}</b><span>CAPAs waiting for me</span></button>
      </div>
      <div className="row">
        {VIEWS.map(([v, label]) => (
          <button key={v} className={view === v && !q ? 'tab on' : 'tab'} onClick={() => pick(v)}>{label}</button>
        ))}
        <form className="search" onSubmit={search}>
          <input aria-label="Search" placeholder="Batch number, deviation number or word" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="submit">Search</button>
        </form>
      </div>
      {rows.length === 0 ? (
        <p className="muted">{q ? 'Nothing found.' : view === 'mine' ? 'Nothing is waiting for you.' : 'No deviations here.'}</p>
      ) : (
        <table className="list">
          <thead>
            <tr><th>Number</th><th>Title</th><th>Product / batch</th><th>Area</th><th>Class</th><th>Status</th><th>Target date</th></tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="click" onClick={() => onOpen(d.id)}>
                <td><button className="link">{d.number}</button>{d.planned && <span className="muted"> · planned</span>}</td>
                <td>{d.title}</td>
                <td>{d.batches || <span className="muted">none</span>}</td>
                <td>{d.area}</td>
                <td>{d.classification ? CLASS_LABEL[d.classification] : '—'}</td>
                <td><span className={`chip ${STEP_CHIP[d.step]}`}>{STEP_LABEL[d.step]}</span>{d.openCapas > 0 && <span className="chip">{d.openCapas} CAPA{d.openCapas > 1 ? 's' : ''} open</span>}{d.waitingForMe && <span className="chip chip-info">you</span>}</td>
                <td>{d.overdue ? <span className="chip chip-bad">Overdue · {plantDate(d.targetDate)}</span> : plantDate(d.targetDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
