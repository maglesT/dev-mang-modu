import type { Sql } from './db.js';
import { fileDeviation, reportData } from './deviations.js';
import { audit } from './audit.js';
import type { Source } from './readers/logbook.js';

// D-50 (owner 2026-11-12, Logbook D-37): every missed limit the Logbook publishes in report.overdue_v1 (overdue
// cleaning, preventive maintenance, calibration, requalification) is filed here once, as a deviation from the automatic
// reporter in the area "Logbook (automatic)", with the Logbook's report text. QA classifies it like any other report.
// The Logbook is only read (its own login, read-only transaction); deviations.source_ref keeps each record filed once.

export const AUTO_REPORTER = 'logbook.auto';
export const AUTO_AREA = 'Logbook (automatic)';
export const SOURCE_PREFIX = 'logbook:overdue:';
// Records older than this are not filed (e.g. when the link is first switched on at a site with a long history).
export const LOOKBACK_DAYS = 30;

interface OverdueRow {
  event_id: string; equipment_code: string; kind: string; due_at: Date;
  title: string; description: string; immediate_action: string; impact_notes: string;
}

/**
 * The automatic reporter (no core employee, so it can never sign in; no password) and, the first time, its area.
 * Made by the app at the first automatic report, not by a migration: the move of a standalone installation needs
 * empty tables. An area an administrator made inactive stays inactive.
 */
async function reporter(sql: Sql): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('automatic_reporter'))`;
    let [u] = await tx<{ id: number }[]>`select id::int from users where username = ${AUTO_REPORTER}`;
    if (!u) {
      [u] = await tx<{ id: number }[]>`insert into users (username, full_name, password_hash, must_change_password)
        values (${AUTO_REPORTER}, 'Logbook (automatic report)', '!', false) returning id::int`;
      await audit(tx, { actorId: u!.id, action: 'user.created', objectType: 'user', objectId: u!.id, new: { username: AUTO_REPORTER, automatic: true } });
    }
    const [a] = await tx<{ id: number }[]>`insert into areas (name) values (${AUTO_AREA}) on conflict (name) do nothing returning id::int`;
    if (a) await audit(tx, { actorId: u!.id, action: 'area.created', objectType: 'area', objectId: a.id, new: { name: AUTO_AREA, automatic: true } });
    return u!.id;
  });
}

export async function fileLogbookOverdue(sql: Sql, src: Source): Promise<{ filed: string[]; problems: string[] }> {
  const rows = await src.sql.begin('read only', async (tx) => {
    await tx`set local statement_timeout = '15s'`;
    return tx<OverdueRow[]>`
      select event_id::text, equipment_code, kind, due_at, title, description, immediate_action, impact_notes
      from ${tx(`${src.schema}.overdue_v1`)} where detected_at > now() - make_interval(days => ${LOOKBACK_DAYS}) order by event_id`;
  });
  const filed: string[] = [];
  const problems: string[] = [];
  if (!rows.length) return { filed, problems };
  const refs = rows.map((r) => `${SOURCE_PREFIX}${r.event_id}`);
  const done = new Set((await sql<{ source_ref: string }[]>`select source_ref from deviations where source_ref = any(${refs})`).map((r) => r.source_ref));
  const todo = rows.filter((r) => !done.has(`${SOURCE_PREFIX}${r.event_id}`));
  if (!todo.length) return { filed, problems };
  const who = await reporter(sql);
  const [area] = await sql<{ id: number }[]>`select id::int from areas where name = ${AUTO_AREA} and active`;
  if (!area) return { filed, problems: [`the area "${AUTO_AREA}" is missing or inactive: missed limits from the Logbook are not filed`] };
  for (const r of todo) {
    const body = reportData.safeParse({
      planned: false, title: r.title.slice(0, 200), description: r.description.slice(0, 5000), areaId: area.id,
      equipment: r.equipment_code.slice(0, 200), eventAt: new Date(r.due_at).toISOString(), products: [], noBatch: true,
      immediateAction: r.immediate_action.slice(0, 5000), actionTakenAt: null,
      initialImpact: { productQuality: 'unknown', patientSafety: 'unknown', otherBatches: 'unknown', notes: r.impact_notes.slice(0, 3000) },
    });
    if (!body.success) { problems.push(`Logbook record ${r.event_id}: ${body.error.issues.map((i) => i.message).join(' ')}`); continue; }
    try {
      const out = await sql.begin((tx) => fileDeviation(tx, body.data, who, `${SOURCE_PREFIX}${r.event_id}`));
      if (out) filed.push(out.number);
    } catch (e) {
      // Another instance filed it first.
      if ((e as { code?: string }).code !== '23505') throw e;
    }
  }
  return { filed, problems };
}

/** Checks every minute inside the server process (as the integrity check does). */
export function scheduleAutoRaise(sql: Sql, src: Source, log: (msg: string) => void, everyMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await fileLogbookOverdue(sql, src);
      if (r.filed.length) log(`missed limits from the Logbook filed as ${r.filed.join(', ')}`);
      for (const p of r.problems) log(p);
    } catch (e) {
      log(`missed limits from the Logbook could not be read: ${(e as { code?: string }).code ?? ''} ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 10_000);
  const timer = setInterval(tick, everyMs);
  return () => { clearTimeout(first); clearInterval(timer); };
}
