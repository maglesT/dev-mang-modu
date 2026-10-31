import type { Sql } from '../db.js';

// S17 (D-37, DV-23): reads the Logbook's read-only report views (contract: docs/07-data-contracts.md).
// Nothing is written to the Logbook. Values are compared as text; no casts on the other system's data.
export interface Source { sql: Sql; schema: string }
export interface Query { batchesNorm: string[]; equipment: string[]; eventAt: Date; from: Date; to: Date }

export interface LogbookData {
  equipment: { code: string; name: string; kind: string; location: string | null; needs_calibration: boolean; sop_refs: string[] }[];
  entries: { entry_id: string; equipment_code: string; type: string; change: string; activity_start: string | null; activity_end: string | null;
    product_code: string | null; batch: string | null; data: Record<string, unknown>; entered_by: string; late: boolean; signed: string[] }[];
  lastPreventive: { equipment_code: string; at: string; data: Record<string, unknown> }[];
  calibrations: { equipment_code: string; performed_at: string | null; result: string | null; next_due: string | null; certificate_ref: string | null }[];
  sops: { type: string; sop_ref: string }[];
  readAt: string;
  dataAsOf: string | null;
}
export const LOGBOOK_VIEWS = ['equipment_v1', 'entry_v1', 'calibration_v1', 'logbook_sop_v1'];

const norm = (col: string) => `lower(regexp_replace(coalesce(${col}, ''), '[\\s\\-/._]+', '', 'g'))`;

export async function readLogbook(src: Source, q: Query): Promise<LogbookData> {
  const s = src.sql;
  const v = (name: string) => s(`${src.schema}.${name}`);
  const codes = q.equipment.map((c) => c.toUpperCase());
  return s.begin('read only', async (tx) => {
    const equipment = await tx<LogbookData['equipment']>`
      select code, name, kind, location, needs_calibration, sop_refs from ${v('equipment_v1')}
      where upper(code) = any(${codes}) order by code`;
    // Entries on the equipment in the window around the event, and every entry naming the batch.
    const entries = await tx<LogbookData['entries']>`
      select entry_id::text, equipment_code, type, change, activity_start, activity_end, product_code, batch, data, entered_by, late, signed
      from ${v('entry_v1')}
      where (upper(equipment_code) = any(${codes}) and coalesce(activity_end, activity_start, entered_at) between ${q.from} and ${q.to})
         or (${q.batchesNorm.length > 0} and ${tx.unsafe(norm('batch'))} = any(${q.batchesNorm}))
      order by coalesce(activity_start, entered_at), entry_id`;
    // The last preventive maintenance before the event, whenever it was.
    const lastPreventive = await tx<LogbookData['lastPreventive']>`
      select distinct on (upper(equipment_code)) equipment_code, coalesce(activity_end, activity_start) as at, data
      from ${v('entry_v1')}
      where upper(equipment_code) = any(${codes}) and type = 'maintenance' and data->>'kind' = 'preventive'
        and coalesce(activity_end, activity_start) <= ${q.eventAt}
      order by upper(equipment_code), coalesce(activity_end, activity_start) desc`;
    // Calibrations performed up to the event (the latest tells whether it was due), and any in the window after.
    const calibrations = await tx<LogbookData['calibrations']>`
      select equipment_code, performed_at, result, next_due::text, certificate_ref from ${v('calibration_v1')}
      where upper(equipment_code) = any(${codes}) and performed_at <= ${q.to}
      order by equipment_code, performed_at desc`;
    const sops = await tx<LogbookData['sops']>`select type, sop_ref from ${v('logbook_sop_v1')} order by type, sop_ref`;
    const [asOf] = await tx<{ at: string | null }[]>`select greatest(
      (select max(data_as_of) from ${v('equipment_v1')} where upper(code) = any(${codes})),
      (select max(data_as_of) from ${v('entry_v1')} where upper(equipment_code) = any(${codes}))) as at`;
    const [now] = await tx<{ at: string }[]>`select now() as at`;
    return { equipment, entries, lastPreventive, calibrations, sops, readAt: now!.at, dataAsOf: asOf?.at ?? null };
  });
}

const DAY = 86_400_000;
const plantDate = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
const days = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY);

// Plain-words findings for the investigator (advice; the copy above is the evidence).
export function logbookFindings(d: LogbookData, q: Query): string[] {
  const out: string[] = [];
  const event = plantDate(q.eventAt);
  for (const e of d.equipment.filter((x) => x.needs_calibration || x.kind === 'instrument')) {
    const last = d.calibrations.find((c) => c.equipment_code.toUpperCase() === e.code.toUpperCase() && c.performed_at && new Date(c.performed_at) <= q.eventAt);
    if (!last) out.push(`${e.code}: no calibration on record before the event.`);
    else if (last.next_due && last.next_due < event) out.push(`${e.code}: calibration was overdue at the event (due ${last.next_due}; event ${event}). Results it gave may not be valid.`);
    else if (last.result && !/^pass/i.test(last.result)) out.push(`${e.code}: last calibration result before the event: ${last.result}.`);
  }
  for (const e of d.equipment.filter((x) => x.kind === 'equipment')) {
    const pm = d.lastPreventive.find((p) => p.equipment_code.toUpperCase() === e.code.toUpperCase());
    if (!pm) out.push(`${e.code}: no preventive maintenance on record before the event.`);
    else if (days(q.eventAt, new Date(pm.at)) > 30) out.push(`${e.code}: last preventive maintenance ${days(q.eventAt, new Date(pm.at))} days before the event. Check whether it was due.`);
  }
  for (const b of d.entries.filter((x) => x.type === 'maintenance' && x.data?.kind === 'breakdown')) {
    const at = new Date(b.activity_start ?? b.activity_end ?? q.eventAt);
    const when = days(q.eventAt, at);
    out.push(`${b.equipment_code}: breakdown ${when > 0 ? `${when} day(s) before` : when < 0 ? `${-when} day(s) after` : 'on the day of'} the event${b.data.failureCategory ? ` (${String(b.data.failureCategory)})` : ''}${b.data.rootCause ? `: ${String(b.data.rootCause)}` : ''}.`);
  }
  const unverified = d.entries.filter((x) => !x.signed.includes('verified') && ['equipment_cleaning', 'calibration', 'maintenance'].includes(x.type));
  if (unverified.length) out.push(`${unverified.length} cleaning, calibration or maintenance entr${unverified.length === 1 ? 'y is' : 'ies are'} not verified in the Logbook.`);
  return out;
}
