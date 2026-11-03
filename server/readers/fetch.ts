import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { normaliseBatch } from '../deviations.js';
import { LOGBOOK_VIEWS, logbookFindings, readLogbook, type Query, type Source } from './logbook.js';
import { BATCHWRIGHT_VIEWS, batchwrightFindings, readBatchwright } from './batchwright.js';

// S17 (D-37, DV-23): "Fetch related data". Reads the Logbook and Batchwright through their read-only views,
// matched on this deviation's batches, equipment and event time, and keeps each result as an insert-only
// copy with a SHA-256. Advice for the investigation; the other systems are never written to.
export interface Sources { logbook?: Source; batchwright?: Source }
export const WINDOW_BEFORE_DAYS = 7;
export const WINDOW_AFTER_DAYS = 1;
const NOT_A_BATCH = new Set(['none', 'na', 'nil', 'nan', 'null', 'nobatch', 'notapplicable', '0']);

export async function buildQuery(sql: Sql, deviationId: number): Promise<(Query & { batches: string[] }) | null> {
  const [r] = await sql<{ data: { eventAt: string; equipment?: string } }[]>`
    select data from latest_sections where deviation_id = ${deviationId} and kind = 'report'`;
  if (!r) return null;
  const rows = await sql<{ batch: string; batch_norm: string }[]>`
    select distinct b.batch, b.batch_norm from batches b join latest_sections s on s.id = b.section_id where b.deviation_id = ${deviationId}`;
  const usable = rows.filter((b) => b.batch_norm && !NOT_A_BATCH.has(b.batch_norm));
  const eventAt = new Date(r.data.eventAt);
  // The equipment field is free text: every word that looks like a code (letters, digits, dashes) is tried.
  // Only words with a digit count as codes (PRESS-01, FBD-01), so "Tablet press" is not looked up as two codes.
  const equipment = [...new Set(String(r.data.equipment ?? '').split(/[\s,;/]+/).map((x) => x.trim()).filter((x) => /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/.test(x) && /\d/.test(x)))];
  return {
    batches: usable.map((b) => b.batch), batchesNorm: usable.map((b) => b.batch_norm), equipment, eventAt,
    from: new Date(eventAt.getTime() - WINDOW_BEFORE_DAYS * 86_400_000), to: new Date(eventAt.getTime() + WINDOW_AFTER_DAYS * 86_400_000),
  };
}

// The error shown and stored says what kind of problem it was; the driver's text (host, port, role) goes to the log only.
export function plainError(e: unknown): string {
  const m = e instanceof Error ? `${(e as { code?: string }).code ?? ''} ${e.message}` : '';
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|connect/i.test(m)) return 'The system could not be reached.';
  if (/password|authentication|no pg_hba|28P01|28000/i.test(m)) return 'The read-only login was refused.';
  if (/statement timeout|57014|canceling statement/i.test(m)) return 'The system took too long to answer (over 15 s).';
  if (/does not exist|42P01|42703|3F000/i.test(m)) return 'An expected report view is missing or has changed.';
  if (/permission denied|42501/i.test(m)) return 'The read-only login may not read the report views.';
  return 'The data could not be read.';
}

// On the platform the Logbook is a link (D-42 slice 4, PL-08): a revoked grant (42501) or a login switched off (28000)
// means the link is cut. The fetch stores this, reads nothing else, and never serves older data.
export const LOGBOOK_OFF = 'Connection to Logbook is off. Ask your administrator.';
const linkCut = (e: unknown) => ['42501', '28000'].includes((e as { code?: string }).code ?? '');

type Outcome = { source: 'logbook' | 'batchwright'; status: 'ok' | 'not_configured' | 'failed'; data: unknown; rows: number; error: string | null; views: string[] };
// Rows read from the other system (not the bookkeeping lists).
const count = (d: Record<string, unknown>) => Object.entries(d).reduce<number>((n, [k, v]) => n + (Array.isArray(v) && !['viewsRead', 'equipmentUsed', 'findings'].includes(k) ? v.length : 0), 0);

export async function fetchRelated(sql: Sql, sources: Sources, deviationId: number, userId: number, log: (msg: string) => void = () => {}) {
  const q = await buildQuery(sql, deviationId);
  if (!q) return null;
  const outcomes: Outcome[] = [];
  // Batchwright first: the equipment the batch actually used is then also looked up in the Logbook.
  let usedEquipment: string[] = [];
  if (!sources.batchwright) outcomes.push({ source: 'batchwright', status: 'not_configured', data: {}, rows: 0, error: null, views: [] });
  else {
    try {
      const d = await readBatchwright(sources.batchwright, q);
      usedEquipment = d.equipmentUsed;
      outcomes.push({ source: 'batchwright', status: 'ok', data: { ...d, findings: batchwrightFindings(d) }, rows: count(d as unknown as Record<string, unknown>), error: null, views: d.viewsRead });
    } catch (e) {
      log(`Batchwright read failed: ${e instanceof Error ? e.message : String(e)}`);
      outcomes.push({ source: 'batchwright', status: 'failed', data: {}, rows: 0, error: plainError(e), views: BATCHWRIGHT_VIEWS });
    }
  }
  const lq = { ...q, equipment: [...new Set([...q.equipment, ...usedEquipment])] };
  if (!sources.logbook) outcomes.push({ source: 'logbook', status: 'not_configured', data: {}, rows: 0, error: null, views: [] });
  else {
    try {
      const d = await readLogbook(sources.logbook, lq);
      outcomes.push({ source: 'logbook', status: 'ok', data: { ...d, findings: logbookFindings(d, lq) }, rows: count(d as unknown as Record<string, unknown>), error: null, views: LOGBOOK_VIEWS });
    } catch (e) {
      log(`Logbook read failed: ${e instanceof Error ? e.message : String(e)}`);
      outcomes.push({ source: 'logbook', status: 'failed', data: {}, rows: 0, error: linkCut(e) ? LOGBOOK_OFF : plainError(e), views: LOGBOOK_VIEWS });
    }
  }
  const params = { batches: q.batches, equipment: lq.equipment, eventAt: q.eventAt, from: q.from, to: q.to };
  return sql.begin(async (tx) => {
    const ids: number[] = [];
    for (const o of outcomes) {
      // The SHA-256 is of the JSON text as PostgreSQL stores it (jsonb normalised), so the integrity check
      // recomputes exactly the same value; the audit row keeps it too.
      const [row] = await tx<{ id: number; sha256: string }[]>`
        with x as (select ${tx.json(o.data as never)}::jsonb as data)
        insert into data_fetches (deviation_id, source, status, params, views, data, row_count, sha256, error, fetched_by)
        select ${deviationId}, ${o.source}, ${o.status}, ${tx.json(params as never)}, ${tx.json(o.views as never)}, x.data, ${o.rows},
               encode(sha256(convert_to(x.data::text, 'UTF8')), 'hex'), ${o.error}, ${userId}
        from x returning id::int, sha256`;
      await audit(tx, { actorId: userId, action: 'data.fetched', objectType: 'deviation', objectId: deviationId,
        new: { fetchId: row!.id, source: o.source, status: o.status, rows: o.rows, sha256: row!.sha256, params, error: o.error } });
      ids.push(row!.id);
    }
    return ids;
  });
}
