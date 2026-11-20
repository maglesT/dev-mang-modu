import type { Sql } from './db.js';
import { fileDeviation, reportData } from './deviations.js';
import { audit } from './audit.js';
import type { Source } from './readers/logbook.js';
import { canRead } from './readers/truebatch.js';
import type { Sources } from './readers/fetch.js';
import { BATCH_PRODUCTS, PRODUCT_NAME, type BatchProduct } from './readers/products.js';

// D-50 (owner 2026-11-12, Logbook D-37): every missed limit the Logbook publishes in report.overdue_v1 (overdue
// cleaning, preventive maintenance, calibration, requalification) is filed here once, as a deviation from the automatic
// reporter in the area "Logbook (automatic)", with the Logbook's report text. QA classifies it like any other report.
// The Logbook is only read (its own login, read-only transaction); deviations.source_ref keeps each record filed once.
// D-51 (owner 2026-11-15): the same for TrueBatch's deviation notes (report.deviation_note_v1) that carry no deviation
// number: each is filed once as a deviation from the automatic reporter truebatch.auto in the area "TrueBatch
// (automatic)", for the note's product and batch; source_ref 'truebatch:note:<note_id>'. A note with a number is a
// deviation already reported, so it is never filed again.
// D-53 (owner 2026-11-15): TrueBatch Tablets Packing publishes the same deviation_note_v1 (same columns); its notes
// without a number are filed the same way, by truebatch_packing.auto in the area "TrueBatch Packing (automatic)";
// source_ref 'truebatch_packing:note:<note_id>'.
// D-54 (owner 2026-11-16): TrueBatch Injectables the same way, by truebatch_injectables.auto in the area
// "TrueBatch Injectables (automatic)"; source_ref 'truebatch_injectables:note:<note_id>'.
// D-55 (owner 2026-11-17): TrueBatch Injectables Packing the same way, by truebatch_injectables_packing.auto in the area
// "TrueBatch Injectables Packing (automatic)"; source_ref 'truebatch_injectables_packing:note:<note_id>'.
// D-59 (owner 2026-11-18): every TrueBatch product in readers/products.ts the same way: by <key>.auto in the area
// "<name> (automatic)"; source_ref '<key>:note:<note_id>' (Capsules, Oral Liquids, their Packing, and API).
// D-58 (suite run S21): the report's Equipment is pulled from the product's equipment_use_v1 for the note's batch: the
// rooms and machines used at the note's step, or, when none was used at that very step (e.g. a line clearance), in the
// note's stage. Empty when the view is not there or not readable.
// D-65 (owner, 20 Nov 2026; replaces the automatic filing of D-50, D-51, D-53 to D-55 and D-59): nothing is filed on its
// own any more. The producing product raises an exception and a person who holds that product's exception permission
// either closes it there (reason and e-signature) or sends it to Deviations. Only rows SENT are filed: overdue_v1 and
// deviation_note_v1 carry `sent_at` (when it was sent; null otherwise), read through the row as JSON, so a producer whose
// view has no such column yet sends nothing. The look-back counts from when it was sent. source_ref keeps each row
// filed once, as before. Standalone (no link) is unchanged: nothing is read.

export const AUTO_REPORTER = 'logbook.auto';
export const AUTO_AREA = 'Logbook (automatic)';
export const SOURCE_PREFIX = 'logbook:overdue:';
// Records older than this are not filed (e.g. when the link is first switched on at a site with a long history).
export const LOOKBACK_DAYS = 30;

/** One automatic source: who files, in which area, and how its records are named in source_ref. */
interface Feed { username: string; fullName: string; area: string; prefix: string; what: string }
const LOGBOOK: Feed = { username: AUTO_REPORTER, fullName: 'Logbook (automatic report)', area: AUTO_AREA, prefix: SOURCE_PREFIX, what: 'missed limits from the Logbook' };
/** D-51, D-53 to D-55, D-59: a TrueBatch product's notes, named after the product (one list: readers/products.ts). */
export const noteFeed = (p: BatchProduct): Feed => ({ username: `${p}.auto`, fullName: `${PRODUCT_NAME[p]} (automatic report)`,
  area: `${PRODUCT_NAME[p]} (automatic)`, prefix: `${p}:note:`, what: `deviation notes from ${PRODUCT_NAME[p]}` });
export const TB_REPORTER = noteFeed('truebatch').username;
export const TB_AREA = noteFeed('truebatch').area;
export const TB_PREFIX = noteFeed('truebatch').prefix;
export const TBP_AREA = noteFeed('truebatch_packing').area;
export const TBP_PREFIX = noteFeed('truebatch_packing').prefix;
export const TBI_AREA = noteFeed('truebatch_injectables').area;
export const TBI_PREFIX = noteFeed('truebatch_injectables').prefix;
export const TBIP_AREA = noteFeed('truebatch_injectables_packing').area;
export const TBIP_PREFIX = noteFeed('truebatch_injectables_packing').prefix;

interface OverdueRow {
  event_id: string; equipment_code: string; kind: string; due_at: Date;
  title: string; description: string; immediate_action: string; impact_notes: string;
}

/**
 * The automatic reporter (no core employee, so it can never sign in; no password) and, the first time, its area.
 * Made by the app at the first automatic report, not by a migration: the move of a standalone installation needs
 * empty tables. An area an administrator made inactive stays inactive.
 */
async function reporter(sql: Sql, f: Feed): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('automatic_reporter'))`;
    let [u] = await tx<{ id: number }[]>`select id::int from users where username = ${f.username}`;
    if (!u) {
      [u] = await tx<{ id: number }[]>`insert into users (username, full_name, password_hash, must_change_password)
        values (${f.username}, ${f.fullName}, '!', false) returning id::int`;
      await audit(tx, { actorId: u!.id, action: 'user.created', objectType: 'user', objectId: u!.id, new: { username: f.username, automatic: true } });
    }
    const [a] = await tx<{ id: number }[]>`insert into areas (name) values (${f.area}) on conflict (name) do nothing returning id::int`;
    if (a) await audit(tx, { actorId: u!.id, action: 'area.created', objectType: 'area', objectId: a.id, new: { name: f.area, automatic: true } });
    return u!.id;
  });
}

type Filed = { filed: string[]; problems: string[] };
/** Files each record not filed before (by source_ref), through the same code as a person's report. */
async function fileAll<R extends { id: string }>(sql: Sql, f: Feed, rows: R[], report: (r: R, areaId: number) => unknown): Promise<Filed> {
  const filed: string[] = [];
  const problems: string[] = [];
  if (!rows.length) return { filed, problems };
  const refs = rows.map((r) => `${f.prefix}${r.id}`);
  const done = new Set((await sql<{ source_ref: string }[]>`select source_ref from deviations where source_ref = any(${refs})`).map((r) => r.source_ref));
  const todo = rows.filter((r) => !done.has(`${f.prefix}${r.id}`));
  if (!todo.length) return { filed, problems };
  const who = await reporter(sql, f);
  const [area] = await sql<{ id: number }[]>`select id::int from areas where name = ${f.area} and active`;
  if (!area) return { filed, problems: [`the area "${f.area}" is missing or inactive: ${f.what} are not filed`] };
  for (const r of todo) {
    const body = reportData.safeParse(report(r, area.id));
    if (!body.success) { problems.push(`${f.what}: record ${r.id}: ${body.error.issues.map((i) => i.message).join(' ')}`); continue; }
    try {
      const out = await sql.begin((tx) => fileDeviation(tx, body.data, who, `${f.prefix}${r.id}`));
      if (out) filed.push(out.number);
    } catch (e) {
      // Another instance filed it first.
      if ((e as { code?: string }).code !== '23505') throw e;
    }
  }
  return { filed, problems };
}

export async function fileLogbookOverdue(sql: Sql, src: Source): Promise<Filed> {
  const rows = await src.sql.begin('read only', async (tx) => {
    await tx`set local statement_timeout = '15s'`;
    return tx<OverdueRow[]>`
      select event_id::text, equipment_code, kind, due_at, title, description, immediate_action, impact_notes
      from (select o.*, (to_jsonb(o)->>'sent_at')::timestamptz as sent from ${tx(`${src.schema}.overdue_v1`)} o) r
      where sent is not null and sent > now() - make_interval(days => ${LOOKBACK_DAYS}) order by event_id`;
  });
  return fileAll(sql, LOGBOOK, rows.map((r) => ({ ...r, id: r.event_id })), (r, areaId) => ({
    planned: false, title: r.title.slice(0, 200), description: r.description.slice(0, 5000), areaId,
    equipment: r.equipment_code.slice(0, 200), eventAt: new Date(r.due_at).toISOString(), products: [], noBatch: true,
    immediateAction: r.immediate_action.slice(0, 5000), actionTakenAt: null,
    initialImpact: { productQuality: 'unknown', patientSafety: 'unknown', otherBatches: 'unknown', notes: r.impact_notes.slice(0, 3000) },
  }));
}

interface NoteRow { note_id: string; batch_number: string; product_code: string | null; step: string | null; note: string | null; noted_at: Date }
export interface UseRow { batch_number: string; equipment_code: string | null; room_code: string | null; step: string | null; step_name: string | null }

// "Packing › Coding check (round 2)" is the step "Packing › Coding check"; compared without case.
const plain = (s: string | null) => (s ?? '').replace(/\s*\(round \d+\)\s*$/i, '').trim().toLowerCase();
// The stage of a readable name ("Aseptic filling › Line clearance") or of keys ("filling/line-clearance").
const stageOf = (s: string | null, keys: boolean) => plain(s).split(keys ? '/' : '›')[0]!.trim();

/**
 * D-58: the rooms and machines a batch used at a note's step, from equipment_use_v1 (one row per room or machine, with
 * the step it was last used at, as keys and as the readable name). Matched at the step; else in the step's stage.
 */
export function equipmentAt(step: string | null, uses: UseRow[]): { text: string; at: 'step' | 'stage' } | null {
  const s = plain(step);
  if (!s) return null;
  let at: 'step' | 'stage' = 'step';
  let hit = uses.filter((u) => plain(u.step) === s || plain(u.step_name) === s);
  if (!hit.length) {
    at = 'stage';
    const stage = stageOf(step, !s.includes('›'));
    hit = uses.filter((u) => stageOf(u.step, true) === stage || stageOf(u.step_name, false) === stage);
  }
  const rooms = [...new Set(hit.map((u) => u.room_code?.trim()).filter((x): x is string => !!x))];
  const machines = [...new Set(hit.map((u) => u.equipment_code?.trim()).filter((x): x is string => !!x && !rooms.includes(x)))];
  if (!rooms.length && !machines.length) return null;
  const parts = [...(rooms.length ? [`${rooms.length > 1 ? 'Rooms' : 'Room'} ${rooms.join(', ')}`] : []), ...(machines.length ? [`equipment ${machines.join(', ')}`] : [])];
  const text = parts.join('; ');
  return { text: (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 200), at };
}

/** D-51, D-53 to D-55, D-59: a TrueBatch product's deviation notes without a deviation number, each filed once for its product and batch. */
export const fileProductNotes = (sql: Sql, src: Source, p: BatchProduct) => fileNotes(sql, src, noteFeed(p), PRODUCT_NAME[p], p);
export const fileTrueBatchNotes = (sql: Sql, src: Source) => fileProductNotes(sql, src, 'truebatch');
export const filePackingNotes = (sql: Sql, src: Source) => fileProductNotes(sql, src, 'truebatch_packing');
export const fileInjectablesNotes = (sql: Sql, src: Source) => fileProductNotes(sql, src, 'truebatch_injectables');
export const fileInjectablesPackingNotes = (sql: Sql, src: Source) => fileProductNotes(sql, src, 'truebatch_injectables_packing');

async function fileNotes(sql: Sql, src: Source, feed: Feed, system: string, product: BatchProduct): Promise<Filed> {
  const { rows, uses } = await src.sql.begin('read only', async (tx) => {
    await tx`set local statement_timeout = '15s'`;
    const rows = await tx<NoteRow[]>`
      select note_id::text, batch_number, product_code, step, note, noted_at
      from (select n.*, (to_jsonb(n)->>'sent_at')::timestamptz as sent from ${tx(`${src.schema}.deviation_note_v1`)} n) r
      where reference is null and sent is not null and sent > now() - make_interval(days => ${LOOKBACK_DAYS}) order by note_id`;
    // D-58: the equipment use of these batches (step_name read as JSON: null where a product does not publish it).
    const batches = [...new Set(rows.map((r) => r.batch_number))];
    const uses = batches.length && await canRead(tx, src.schema, 'equipment_use_v1') ? await tx<UseRow[]>`
      select x->>'batch_number' as batch_number, x->>'equipment_code' as equipment_code, x->>'room_code' as room_code, x->>'step' as step, x->>'step_name' as step_name
      from (select to_jsonb(u) as x from ${tx(`${src.schema}.equipment_use_v1`)} u where u.batch_number = any(${batches})) r limit 5000` : [];
    return { rows, uses };
  });
  return fileAll(sql, feed, rows.map((r) => ({ ...r, id: r.note_id })), (r, areaId) => {
    // The step as the view names it (TrueBatch and Packing give the readable name people see on the batch record), used as given:
    // Deviations keeps no list of TrueBatch's steps and builds no name from keys.
    const step = (r.step ?? '').trim() || 'step not named';
    const text = (r.note ?? '').trim() || '(no text)';
    const eq = equipmentAt(r.step, uses.filter((u) => u.batch_number === r.batch_number));
    const eqLine = eq ? ` Equipment pulled from the ${system} equipment use of ${r.batch_number} ${eq.at === 'step' ? 'at this step' : 'in this stage'}.` : '';
    return {
      planned: false, title: `Batch ${r.batch_number}, ${step}: ${text}`.slice(0, 200),
      description: `${text}\n\nDeviation note ${r.note_id} in the ${system} batch record of ${r.batch_number}, step ${step}. Filed automatically from ${system}.${eqLine}`.slice(0, 5000),
      areaId, equipment: eq?.text ?? '', eventAt: new Date(r.noted_at).toISOString(),
      // D-57: the batch comes from the product's own note, so it is pulled, not typed by hand.
      products: [{ product: (r.product_code ?? '').trim() || `not named in ${system}`, batch: r.batch_number, from: product }], noBatch: false,
      immediateAction: `As written in the ${system} note and batch record of ${r.batch_number} (step ${step}).`, actionTakenAt: null,
      initialImpact: { productQuality: 'unknown', patientSafety: 'unknown', otherBatches: 'unknown', notes: `Filed automatically from ${system}; QA to assess the impact.` },
    };
  });
}

/** Checks every minute inside the server process (as the integrity check does), each linked source on its own. */
export function scheduleAutoRaise(sql: Sql, src: Sources, log: (msg: string) => void, everyMs = 60_000): () => void {
  let running = false;
  const jobs = [
    ...(src.logbook ? [{ f: LOGBOOK, run: () => fileLogbookOverdue(sql, src.logbook!) }] : []),
    // D-59: each linked TrueBatch product, in the order of the one list.
    ...BATCH_PRODUCTS.filter((p) => src[p]).map((p) => ({ f: noteFeed(p), run: () => fileProductNotes(sql, src[p]!, p) })),
  ];
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const j of jobs) {
        try {
          const r = await j.run();
          if (r.filed.length) log(`${j.f.what} filed as ${r.filed.join(', ')}`);
          for (const p of r.problems) log(p);
        } catch (e) {
          log(`${j.f.what} could not be read: ${(e as { code?: string }).code ?? ''} ${(e as Error).message}`);
        }
      }
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 10_000);
  const timer = setInterval(tick, everyMs);
  return () => { clearTimeout(first); clearInterval(timer); };
}
