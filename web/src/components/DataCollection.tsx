import { useEffect, useState } from 'react';
import { api, plantTime } from '../api.js';

// S17 (D-37, DV-23): data from the Logbook and Batchwright for this deviation. Each fetch is a kept copy
// (read-only, checksummed); the newest per source is shown, older ones are listed.
type Row = Record<string, unknown>;
interface Fetch {
  id: number; source: 'logbook' | 'batchwright'; status: 'ok' | 'not_configured' | 'failed';
  params: { batches: string[]; equipment: string[]; from: string; to: string }; views: string[];
  data: Row & { findings?: string[]; readAt?: string; dataAsOf?: string | null };
  rowCount: number; sha256: string; error: string | null; fetchedAt: string; fetchedBy: string;
}
const NAME = { logbook: 'Logbook', batchwright: 'Batch record (Batchwright)' } as const;
const s = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
const time = (v: unknown) => (v ? plantTime(String(v)) : '—');
const list = (v: unknown) => (Array.isArray(v) ? (v as Row[]) : []);

function Table({ title, cols, rows, bad }: { title: string; cols: [string, (r: Row) => string][]; rows: Row[]; bad?: (r: Row) => boolean }) {
  if (!rows.length) return null;
  return (
    <details className="tool">
      <summary>{title} ({rows.length})</summary>
      <div className="scroll"><table className="trend">
        <thead><tr>{cols.map(([h]) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className={bad?.(r) ? 'spike' : undefined}>{cols.map(([h, f]) => <td key={h}>{f(r)}</td>)}</tr>)}</tbody>
      </table></div>
    </details>
  );
}

function SourceView({ f }: { f: Fetch }) {
  const d = f.data;
  return (
    <div className="source">
      <h3>{NAME[f.source]}</h3>
      {f.status === 'not_configured' && <p className="muted small">Not connected on this installation.</p>}
      {f.status === 'failed' && <p className="error">Could not read it: {f.error}</p>}
      {f.status === 'ok' && <>
        {(d.findings ?? []).length > 0 && <ul className="flags" aria-label={`${NAME[f.source]}: what the data shows`}>{d.findings!.map((x) => <li key={x}>{x}</li>)}</ul>}
        {f.source === 'batchwright' ? <>
          <Table title="Batches" rows={list(d.batches)} cols={[['Batch', (r) => s(r.batch_number)], ['Product', (r) => s(r.product_code)], ['Status', (r) => s(r.status)], ['Issued', (r) => time(r.issued_at)], ['Released', (r) => (r.released ? 'yes' : 'no')]]} />
          <Table title="Steps, equipment and rooms" rows={list(d.steps)} cols={[['Batch', (r) => s(r.batch_number)], ['Step', (r) => s(r.step_id ?? r.step)], ['Equipment', (r) => s(r.equipment_code)], ['Room', (r) => s(r.room_code)], ['Start', (r) => time(r.started_at)], ['End', (r) => time(r.ended_at)], ['Material lots', (r) => list(r.material_lots).map((l) => s(l.lot)).join(', ')]]} />
          <Table title="Recorded values and limits" rows={list(d.values)} bad={(r) => r.failed === true}
            cols={[['Batch', (r) => s(r.batch_number)], ['Step', (r) => s(r.step)], ['Item', (r) => s(r.item)], ['Value', (r) => `${s(r.value_text)} ${r.unit ?? ''}`], ['Limits', (r) => `${s(r.lower_text)} – ${s(r.upper_text)}`], ['Failed', (r) => (r.failed ? 'yes' : '')], ['Recorded', (r) => time(r.recorded_at)]]} />
          <Table title="Exceptions" rows={list(d.exceptions)} cols={[['Batch', (r) => s(r.batch_number)], ['Exception', (r) => s(r.exception_id)], ['Type', (r) => s(r.exception_type)], ['Severity', (r) => s(r.severity)], ['Raised', (r) => time(r.raised_at)]]} />
          <Table title="Alarms" rows={list(d.alarms)} cols={[['Alarm', (r) => s(r.alarm_code)], ['On', (r) => s(r.subject_code)], ['GMP-critical', (r) => (r.gmp_critical ? 'yes' : '')], ['Raised', (r) => time(r.raised_at)], ['Acknowledged', (r) => time(r.acked_at)]]} />
          <Table title="SOPs and documents the master record cites" rows={list(d.references)} cols={[['Kind', (r) => s(r.kind)], ['Code', (r) => s(r.code)], ['Version', (r) => s(r.version)], ['Title', (r) => s(r.title)]]} />
        </> : <>
          <Table title="Logbook entries around the event and for the batch" rows={list(d.entries)} cols={[['Equipment', (r) => s(r.equipment_code)], ['Type', (r) => s(r.type).replace(/_/g, ' ')], ['Start', (r) => time(r.activity_start)], ['End', (r) => time(r.activity_end)], ['Batch', (r) => s(r.batch)], ['Signed', (r) => list(r.signed).join(', ')], ['By', (r) => s(r.entered_by)]]} />
          <Table title="Calibrations" rows={list(d.calibrations)} cols={[['Instrument', (r) => s(r.equipment_code)], ['Performed', (r) => time(r.performed_at)], ['Result', (r) => s(r.result)], ['Next due', (r) => s(r.next_due)], ['Certificate', (r) => s(r.certificate_ref)]]} />
          <Table title="Last preventive maintenance" rows={list(d.lastPreventive)} cols={[['Equipment', (r) => s(r.equipment_code)], ['Done', (r) => time(r.at)]]} />
          <Table title="SOPs (equipment and logbook settings)" rows={[...list(d.equipment).flatMap((e) => list(e.sop_refs).map((x) => ({ where: e.code, sop: x }))), ...list(d.sops).map((x) => ({ where: `${s(x.type)} logbook`, sop: x.sop_ref }))]}
            cols={[['Where', (r) => s(r.where)], ['SOP', (r) => s(r.sop)]]} />
        </>}
      </>}
      <p className="muted small">Read {time(f.fetchedAt)} by {f.fetchedBy}{d.dataAsOf ? ` · data as of ${time(d.dataAsOf)}` : ''} · {f.rowCount} rows · views {f.views.join(', ') || '—'} · SHA-256 {f.sha256.slice(0, 12)}…</p>
    </div>
  );
}

export function DataCollection({ deviationId, canFetch }: { deviationId: number; canFetch: boolean }) {
  const [fetches, setFetches] = useState<Fetch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => setFetches(await api<Fetch[]>('GET', `/api/deviations/${deviationId}/fetches`));
  useEffect(() => { void load().catch(() => setFetches([])); }, [deviationId]);
  const fetchNow = async () => {
    setBusy(true); setError('');
    try { await api('POST', `/api/deviations/${deviationId}/fetch`, {}); await load(); } catch { setError('The data could not be fetched. Please try again.'); } finally { setBusy(false); }
  };
  const latest = (src: Fetch['source']) => fetches?.find((f) => f.source === src);
  const first = fetches?.[0];
  return (
    <section className="card" aria-label="Data collection">
      <div className="section-head"><h2>Data collection</h2>
        {canFetch && <button onClick={fetchNow} disabled={busy}>{busy ? 'Fetching…' : fetches?.length ? 'Fetch again' : 'Fetch related data'}</button>}
      </div>
      <p className="muted small">Reads the batch record and the Logbook for this deviation's batch, its equipment and the equipment the batch used, from {7} days before to 1 day after the event. Each fetch is kept as a read-only copy; nothing is changed in the other systems.</p>
      {error && <p className="error">{error}</p>}
      {first && <p className="small">Matched: batch {first.params.batches.join(', ') || 'none'} · equipment {first.params.equipment.join(', ') || 'none'} · {time(first.params.from)} to {time(first.params.to)}</p>}
      {(['batchwright', 'logbook'] as const).map((src) => { const f = latest(src); return f ? <SourceView key={src} f={f} /> : null; })}
      {fetches && fetches.length > 2 && (
        <details><summary className="small">Earlier fetches ({fetches.length - 2})</summary>
          <ul className="plain small">{fetches.slice(2).map((f) => <li key={f.id}>{NAME[f.source]} · {f.status} · {time(f.fetchedAt)} · {f.fetchedBy} · {f.rowCount} rows · SHA-256 {f.sha256.slice(0, 12)}…</li>)}</ul>
        </details>
      )}
    </section>
  );
}
