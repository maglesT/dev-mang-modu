import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { oosRoomArea } from '../words.js';
import type { Source } from './logbook.js';

// D-60: Medhanta LIMS publishes each OOS (out-of-specification result) in report.oos_v1 (database lims; contract:
// docs/07-data-contracts.md). QA files the phase II investigation of an OOS here by picking it: the product or material,
// lot, test, result, limit, phase I outcome and OOS number come from the view, never typed. The deviation keeps the
// OOS (report data `oos`, source_ref 'lims:oos:<oos_id>', unique), so an OOS is filed once. LIMS is only read, through
// its own link (LIMS_DATABASE_URL; absent = off). LIMS then picks this deviation as the OOS's phase II deviation from
// deviation_v1 (it names the OOS lot as its batch).
export const LIMS_VIEWS = ['oos_v1'];
export const OOS_PREFIX = 'lims:oos:';
export const PICK_LIMIT = 300;
export const LIMS_OFF = 'Connection to LIMS is off. Ask your administrator.';

interface OosRow {
  oos_id: string; oos_number: string; sample_number: string | null; lot_number: string | null; item_kind: string | null;
  item_code: string | null; item_name: string | null; analysis_number: string | null; test_name: string | null;
  shown: string | null; value: string | null; unit: string | null; limit_text: string | null; status: string;
  phase_ii_needed: boolean | null; deviation_number: string | null; opened_at: string;
  em_batch: string | null; point_code: string | null; room_code: string | null;
}

/** An OOS as the report keeps it (report data `oos`): read from LIMS at filing, never typed. */
export type OosRef = {
  id: string; number: string; sample: string; lot: string; itemKind: string; itemCode: string; itemName: string;
  analysis: string; test: string; result: string; limit: string; phaseI: string; openedAt: string;
  // LIMS migration 0031 (an environmental-monitoring OOS): the batch the sample was taken during, its point and room.
  // Absent in reports filed before, or when the view does not have them yet.
  batch?: string; point?: string; room?: string;
};
/** One line of the pick list: the OOS, whether phase II can be filed, and the deviation that already has it. */
export type OosPick = OosRef & { status: string; phaseII: boolean; filed: string | null };

const s = (v: string | null | undefined) => (v ?? '').trim();
export const PHASE_I_DONE = 'Phase I found no laboratory error (reviewed in LIMS): phase II needed.';
export const PHASE_I_OPEN = 'No phase II now: phase I is not finished or not reviewed in LIMS, or it found a laboratory error.';

// D-61: `shown` is the result as LIMS reports it, unit included ("0.9 %"): kept as it is. Only when LIMS gives no shown
// text is it built from the value and the unit.
export const resultText = (r: Pick<OosRow, 'shown' | 'value' | 'unit'>) => s(r.shown) || [s(r.value), s(r.unit)].filter(Boolean).join(' ');

function ref(r: OosRow): OosRef {
  return {
    id: r.oos_id, number: r.oos_number, sample: s(r.sample_number), lot: s(r.lot_number), itemKind: s(r.item_kind).toLowerCase(),
    itemCode: s(r.item_code), itemName: s(r.item_name), analysis: s(r.analysis_number), test: s(r.test_name),
    result: resultText(r), limit: s(r.limit_text),
    phaseI: r.phase_ii_needed ? PHASE_I_DONE : PHASE_I_OPEN, openedAt: new Date(r.opened_at).toISOString(),
    ...(s(r.em_batch) ? { batch: s(r.em_batch) } : {}), ...(s(r.point_code) ? { point: s(r.point_code) } : {}), ...(s(r.room_code) ? { room: s(r.room_code) } : {}),
  };
}

// The view's first columns (migration 0010 of LIMS), and the EM columns of its migration 0031 read through to_jsonb, so a
// view without them still reads (they are then empty).
const COLUMNS = `oos_id::text, oos_number, sample_number, lot_number, item_kind, item_code, item_name, analysis_number, test_name, shown,
  value::text, unit, limit_text, status, phase_ii_needed, deviation_number, opened_at,
  to_jsonb(o) ->> 'batch_number' as em_batch, to_jsonb(o) ->> 'point_code' as point_code, to_jsonb(o) ->> 'room_code' as room_code`;

async function read<T>(src: Source, f: (tx: Tx, view: string) => Promise<T>): Promise<T> {
  return (await src.sql.begin('read only', async (tx) => {
    await tx`set local statement_timeout = '10s'`;
    return f(tx, `${src.schema}.oos_v1`);
  })) as T;
}

/** The deviations of this system filed for these OOS (by source_ref): OOS id -> deviation number. */
async function filedHere(sql: Sql | Tx, ids: string[]): Promise<Map<string, string>> {
  const rows = await sql<{ source_ref: string; number: string }[]>`
    select source_ref, number from deviations where source_ref = any(${ids.map((id) => OOS_PREFIX + id)})`;
  return new Map(rows.map((r) => [r.source_ref.slice(OOS_PREFIX.length), r.number]));
}

/**
 * The open OOS of LIMS, newest first: each with whether phase II can be filed and the deviation that already has it
 * (filed here, or named in LIMS as its phase II deviation). Concluded OOS are not listed.
 */
export async function listOos(sql: Sql, src: Source): Promise<OosPick[]> {
  const rows = await read(src, (tx, v) => tx<OosRow[]>`
    select ${tx.unsafe(COLUMNS)} from ${tx(v)} as o where status = 'OPEN' order by opened_at desc limit ${PICK_LIMIT}`);
  const here = await filedHere(sql, rows.map((r) => r.oos_id));
  return rows.map((r) => ({ ...ref(r), status: r.status, phaseII: !!r.phase_ii_needed, filed: here.get(r.oos_id) ?? (s(r.deviation_number) || null) }));
}

/**
 * The check, once, on filing: the picked OOS read now from LIMS. Returns the OOS as the report keeps it, or the
 * problem in plain words (not linked, not readable, not there, concluded, no phase II needed, already filed). Two
 * filings at the same moment: the unique source_ref refuses the second (fileOos).
 */
export async function pickOos(sql: Sql, src: Source | undefined, id: string): Promise<{ oos: OosRef } | { problem: string }> {
  if (!src) return { problem: 'LIMS is not connected on this installation, so an OOS cannot be picked.' };
  let row: OosRow | undefined;
  try {
    [row] = await read(src, (q, v) => q<OosRow[]>`select ${q.unsafe(COLUMNS)} from ${q(v)} as o where oos_id::text = ${id}`);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    return { problem: ['42501', '28000'].includes(code) ? LIMS_OFF : 'LIMS could not be read now. Try again later.' };
  }
  if (!row) return { problem: 'This OOS is not in LIMS. Pick it from the list again.' };
  const done = (await filedHere(sql, [row.oos_id])).get(row.oos_id);
  if (done) return { problem: `${row.oos_number} already has deviation ${done}. Open that deviation instead.` };
  if (s(row.deviation_number)) return { problem: `${row.oos_number} already has deviation ${s(row.deviation_number)} in LIMS. Open that deviation instead.` };
  if (row.status !== 'OPEN') return { problem: `${row.oos_number} is concluded in LIMS (${row.status.toLowerCase()}): no phase II is filed for it.` };
  if (!row.phase_ii_needed) return { problem: `${row.oos_number}: ${PHASE_I_OPEN}` };
  return { oos: ref(row) };
}

/** The report's row of product and lot for the OOS: pulled from LIMS (`from` lims), not typed. */
// An EM OOS taken during a batch names that batch (LIMS 0031), not the sampling point.
export const oosProduct = (o: OosRef) => ({ product: o.itemCode || o.itemName || 'not named in LIMS', batch: o.batch || o.lot || o.sample, from: 'lims' as const });

// D-61: an OOS is a QC laboratory deviation, and the report's areas are the plant's production areas. Picking an OOS sets
// the area to this one (not chosen on the form). It is made by the app the first time an OOS is filed, audited
// 'area.created' (automatic), as the areas of the automatic reporters are (D-50). An area an administrator made
// inactive stays inactive.
export const LIMS_AREA = 'QC laboratory (Medhanta LIMS)';
export const LIMS_AREA_OFF = `The area of this OOS ("${LIMS_AREA}", or for an environmental-monitoring OOS its room) is inactive, so the OOS cannot be filed. Ask your administrator.`;

/**
 * The id of the OOS's area (made the first time, in the filing transaction), or null when it is inactive: the QC
 * laboratory, or for an EM OOS its room (display backlog 19 Nov 2026): an area named with the room code is used, else
 * "<room> <room name>" is made.
 */
export async function limsArea(tx: Tx, userId: number, oos?: OosRef): Promise<number | null> {
  const room = oos ? oosRoomArea(oos) : null;
  const code = oos?.room || (room ? room.split(' ')[0]! : '');
  if (room) {
    const [known] = await tx<{ id: number; active: boolean }[]>`
      select id::int, active from areas where name = ${code} or name ilike ${code.replace(/[\\%_]/g, (m) => `\\${m}`) + ' %'} order by active desc, id limit 1`;
    if (known) return known.active ? known.id : null;
  }
  const name = room ?? LIMS_AREA;
  const [made] = await tx<{ id: number }[]>`insert into areas (name) values (${name}) on conflict (name) do nothing returning id::int`;
  if (made) await audit(tx, { actorId: userId, action: 'area.created', objectType: 'area', objectId: made.id, new: { name, automatic: true } });
  const [a] = await tx<{ id: number }[]>`select id::int from areas where name = ${name} and active`;
  return a?.id ?? null;
}
