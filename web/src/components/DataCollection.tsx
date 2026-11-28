import { useEffect, useState } from 'react';
import { api, plantDate, plantTime } from '../api.js';
import { BATCH_PRODUCTS, PRODUCT_NAME } from '../../../server/readers/products.js';

// S17 (D-37, DV-23): data from the TrueBatch products (D-51, D-57, D-59) and the Logbook for this deviation. Each fetch is a kept copy
// (read-only, checksummed); the newest per source is shown, older ones are listed. Copies read from Batchwright before it
// was retired (D-56) are still shown as kept, with the tables of its other views.
type Row = Record<string, unknown>;
interface Fetch {
  id: number; source: string; status: 'ok' | 'not_configured' | 'failed';
  params: { batches: string[]; equipment: string[]; from: string; to: string }; views: string[];
  data: Row & { findings?: string[]; readAt?: string; dataAsOf?: string | null };
  rowCount: number; sha256: string; error: string | null; fetchedAt: string; fetchedBy: string;
}
// D-57, D-59: every TrueBatch product (the one list, shared with the server), each its own copy.
const NAME: Record<string, string> = { ...Object.fromEntries(BATCH_PRODUCTS.map((p) => [p, `Batch record (${PRODUCT_NAME[p]})`])), logbook: 'LEAD (logbooks)' };
const SOURCES = [...BATCH_PRODUCTS, 'logbook'];
const s = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
const time = (v: unknown) => (v ? plantTime(String(v)) : '—');
const rowsText = (n: number) => `${n.toLocaleString('en-IN')} ${n === 1 ? 'row' : 'rows'}`;
const STATUS: Record<Fetch['status'], string> = { ok: 'read', not_configured: 'not linked', failed: 'could not be read' };
// Item 27 (display backlog): a batch is in one TrueBatch product only; the products read without finding it are one line.
const isBatchRecord = (src: string) => (BATCH_PRODUCTS as readonly string[]).includes(src);
const notFound = (f: Fetch) => isBatchRecord(f.source) && f.status === 'ok' && list(f.data.batches).length === 0;
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
        {(d.findings ?? []).length > 0 && <ul className="flags" aria-label={`${NAME[f.source]}: what the data shows`}>{d.findings!.map((x, i) => <li key={i}>{x}</li>)}</ul>}
        {f.source !== 'logbook' ? <>
          <Table title="Batches" rows={list(d.batches)} cols={[['Batch', (r) => s(r.batch_number)], ['Product', (r) => s(r.product_code)], ['Status', (r) => s(r.status)], ['Issued', (r) => time(r.issued_at)], ['Released', (r) => (r.released ? 'yes' : 'no')],
            ...(list(d.batches).some((r) => r.coded_batch_number) ? [['Batch on the packs', (r: Row) => s(r.coded_batch_number)] as [string, (r: Row) => string]] : [])]} />
          <Table title="In-process checks" rows={list(d.ipc)} bad={(r) => /fail/i.test(String(r.result ?? ''))}
            cols={[['Batch', (r) => s(r.batch_number)], ['Step', (r) => s(r.step_title ?? r.step)], ['Check', (r) => s(r.item)], ['Instrument', (r) => s(r.instrument_code)],
              ['Reading', (r) => (r.aggregate ? s(r.aggregate) : s(r.reading))], ['Value', (r) => `${s(r.value_text)} ${r.unit ?? ''}`], ['Limits', (r) => `${s(r.lower_text)} – ${s(r.upper_text)}`],
              ['Alert', (r) => (r.alert_lower_text || r.alert_upper_text ? `${s(r.alert_lower_text)} – ${s(r.alert_upper_text)}` : '')], ['Result', (r) => s(r.result)], ['Recorded', (r) => time(r.recorded_at)]]} />
          <Table title="Process actuals" rows={list(d.actuals)} bad={(r) => r.within_limits === false}
            cols={[['Batch', (r) => s(r.batch_number)], ['Step', (r) => s(r.step)], ['Tag', (r) => s(r.tag)], ['Value', (r) => `${s(r.value_text)} ${r.unit ?? ''}`], ['Limits', (r) => `${s(r.lower_text)} – ${s(r.upper_text)}`], ['Within', (r) => (r.within_limits === false ? 'no' : r.within_limits ? 'yes' : '—')], ['Recorded', (r) => time(r.recorded_at)]]} />
          <Table title="Equipment used" rows={list(d.equipmentUse)} cols={[['Batch', (r) => s(r.batch_number)], ['Equipment', (r) => s(r.equipment_code)], ['Type', (r) => s(r.equipment_type)], ['Room', (r) => s(r.room_code)], ['Step', (r) => s(r.step)], ['Start', (r) => time(r.started_at)], ['End', (r) => time(r.ended_at)]]} />
          <Table title="Exceptions in detail" rows={list(d.exceptionDetails)} bad={(r) => !r.disposition}
            cols={[['Batch', (r) => s(r.batch_number)], ['Exception', (r) => s(r.exception_id)], ['Type', (r) => s(r.exception_type)], ['Severity', (r) => s(r.severity)], ['Step', (r) => s(r.step_title ?? r.step)], ['What', (r) => s(r.description)], ['Status', (r) => s(r.status)], ['Disposition', (r) => s(r.disposition)], ['By', (r) => s(r.disposed_by)], ['Raised', (r) => time(r.raised_at)]]} />
          <Table title="Steps, equipment and rooms" rows={list(d.steps)} cols={[['Batch', (r) => s(r.batch_number)], ['Step', (r) => s(r.step_id ?? r.step)], ['Equipment', (r) => s(r.equipment_code)], ['Room', (r) => s(r.room_code)], ['Start', (r) => time(r.started_at)], ['End', (r) => time(r.ended_at)], ['Material lots', (r) => list(r.material_lots).map((l) => s(l.lot)).join(', ')]]} />
          <Table title="Recorded values and limits" rows={list(d.values)} bad={(r) => r.failed === true}
            cols={[['Batch', (r) => s(r.batch_number)], ['Step', (r) => s(r.step)], ['Item', (r) => s(r.item)], ['Value', (r) => `${s(r.value_text)} ${r.unit ?? ''}`], ['Limits', (r) => `${s(r.lower_text)} – ${s(r.upper_text)}`], ['Failed', (r) => (r.failed ? 'yes' : '')], ['Recorded', (r) => time(r.recorded_at)]]} />
          <Table title="Exceptions" rows={list(d.exceptions)} cols={[['Batch', (r) => s(r.batch_number)], ['Exception', (r) => s(r.exception_id)], ['Type', (r) => s(r.exception_type)], ['Severity', (r) => s(r.severity)], ['Raised', (r) => time(r.raised_at)]]} />
          <Table title="Alarms" rows={list(d.alarms)} cols={[['Alarm', (r) => s(r.alarm_code)], ['On', (r) => s(r.subject_code)], ['GMP-critical', (r) => (r.gmp_critical ? 'yes' : '')], ['Raised', (r) => time(r.raised_at)], ['Acknowledged', (r) => time(r.acked_at)]]} />
          <Table title="SOPs and documents the master record cites" rows={list(d.references)} cols={[['Kind', (r) => s(r.kind)], ['Code', (r) => s(r.code)], ['Version', (r) => s(r.version)], ['Title', (r) => s(r.title)]]} />
        </> : <>
          <Table title="LEAD logbook entries around the event and for the batch" rows={list(d.entries)} cols={[['Equipment', (r) => s(r.equipment_code)], ['Type', (r) => s(r.type).replace(/_/g, ' ')], ['Start', (r) => time(r.activity_start)], ['End', (r) => time(r.activity_end)], ['Batch', (r) => s(r.batch)], ['Signed', (r) => list(r.signed).join(', ')], ['By', (r) => s(r.entered_by)]]} />
          <Table title="Calibrations" rows={list(d.calibrations)} cols={[['Instrument', (r) => s(r.equipment_code)], ['Performed', (r) => time(r.performed_at)], ['Result', (r) => s(r.result)], ['Next due', (r) => (r.next_due ? plantDate(String(r.next_due).slice(0, 10)) : '—')], ['Certificate', (r) => s(r.certificate_ref)]]} />
          <Table title="Last preventive maintenance" rows={list(d.lastPreventive)} cols={[['Equipment', (r) => s(r.equipment_code)], ['Done', (r) => time(r.at)]]} />
          <Table title="SOPs (equipment and logbook settings)" rows={[...list(d.equipment).flatMap((e) => list(e.sop_refs).map((x) => ({ where: e.code, sop: x }))), ...list(d.sops).map((x) => ({ where: `${s(x.type)} logbook`, sop: x.sop_ref }))]}
            cols={[['Where', (r) => s(r.where)], ['SOP', (r) => s(r.sop)]]} />
        </>}
      </>}
      <p className="muted small">Read {time(f.fetchedAt)} by {f.fetchedBy}{d.dataAsOf ? ` · data as of ${time(d.dataAsOf)}` : ''} · {rowsText(f.rowCount)} · SHA-256 {f.sha256.slice(0, 12)}…</p>
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
    try { await api('POST', `/api/deviations/${deviationId}/fetch`, {}); await load(); } catch (e) { setError(e instanceof Error && e.message !== 'too_soon' && e.message.length > 12 ? e.message : 'The data was fetched less than 30 seconds ago, or could not be fetched. Please try again shortly.'); } finally { setBusy(false); }
  };
  const latest = (src: Fetch['source']) => fetches?.find((f) => f.source === src);
  const first = fetches?.[0];
  // The newest copy per source is shown in full; every other copy is listed as an earlier fetch.
  const shown = new Set(SOURCES.map((src) => latest(src)?.id));
  // Copies from the retired earlier batch-record system are not listed (its link is gone).
  const earlier = (fetches ?? []).filter((f) => !shown.has(f.id) && f.source in NAME);
  const missing = SOURCES.map((src) => latest(src)).filter((f): f is Fetch => !!f && notFound(f));
  return (
    <section className="card" aria-label="Data collection">
      <div className="section-head"><h2>Data collection</h2>
        {canFetch && <button onClick={fetchNow} disabled={busy}>{busy ? 'Fetching…' : fetches?.length ? 'Fetch again' : 'Fetch related data'}</button>}
      </div>
      <p className="muted small">Reads the batch records (each linked TrueBatch product) and LEAD (the logbooks) for this deviation's batch, its equipment and the equipment the batch used, from {7} days before to 1 day after the event. Each fetch is kept as a read-only copy; nothing is changed in the other systems.</p>
      {error && <p className="error">{error}</p>}
      {first && <p className="small">Matched: batch {first.params.batches.join(', ') || 'none'} · equipment {first.params.equipment.join(', ') || 'none'} · {time(first.params.from)} to {time(first.params.to)}</p>}
      {SOURCES.map((src) => { const f = latest(src); return f && !notFound(f) ? <SourceView key={src} f={f} /> : null; })}
      {missing.length > 0 && (
        <p className="muted small" aria-label="Batch records without this batch">
          {missing.length < SOURCES.filter((src) => isBatchRecord(src) && latest(src)).length
            ? `Also read, the batch is not there: ${missing.map((f) => PRODUCT_NAME[f.source as keyof typeof PRODUCT_NAME]).join(', ')}.`
            : `No batch with this number was found in ${missing.map((f) => PRODUCT_NAME[f.source as keyof typeof PRODUCT_NAME]).join(', ')}.`}
          {' '}Fetch again to look in every linked product.
        </p>
      )}
      {earlier.length > 0 && (
        <details><summary className="small">Earlier fetches ({earlier.length})</summary>
          <ul className="plain small">{earlier.map((f) => <li key={f.id}>{NAME[f.source]} · {STATUS[f.status] ?? f.status} · {time(f.fetchedAt)} · {f.fetchedBy} · {rowsText(f.rowCount)} · SHA-256 {f.sha256.slice(0, 12)}…</li>)}</ul>
        </details>
      )}
    </section>
  );
}
