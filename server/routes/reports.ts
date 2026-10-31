import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Content } from 'pdfmake/interfaces.js';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { parseId, requireRole } from '../auth.js';
import { FISHBONE, PLANT_TZ, normaliseBatch } from '../deviations.js';
import { fields, heading, plant, render, t, table } from '../pdf.js';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const trendQuery = z.object({
  from: month,
  to: month,
  by: z.enum(['area', 'type', 'classification']).default('area'),
  product: z.string().trim().max(200).default(''),
});
// S10 (D-30): one simple statistical flag. A month is marked when its count is above its own usual level:
// the average of the 12 months before it plus 3 times the square root of that average (a c-chart upper limit,
// as for counts of events). At least 6 earlier months are needed, and a month needs at least 3 deviations.
const BASELINE_MONTHS = 12;
const MIN_HISTORY = 6;
const MIN_COUNT = 3;
export const addMonths = (m: string, k: number) => {
  const i = Number(m.slice(0, 4)) * 12 + Number(m.slice(5)) - 1 + k;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};
export interface Spike { key: string | null; month: string; n: number; mean: number; limit: number }
export function spikeFlags(rows: { key: string; month: string; n: number }[], from: string, to: string, firstMonth: string): Spike[] {
  // Series: each key, and null for all deviations together. Months before the first deviation on record do not count as history.
  const series = new Map<string | null, Map<string, number>>([[null, new Map()]]);
  for (const r of rows) {
    if (!series.has(r.key)) series.set(r.key, new Map());
    series.get(r.key)!.set(r.month, (series.get(r.key)!.get(r.month) ?? 0) + r.n);
    series.get(null)!.set(r.month, (series.get(null)!.get(r.month) ?? 0) + r.n);
  }
  const start = firstMonth;
  const out: Spike[] = [];
  for (const [key, byMonth] of series) {
    for (let m = from; m <= to; m = addMonths(m, 1)) {
      const n = byMonth.get(m) ?? 0;
      if (n < MIN_COUNT) continue;
      const history: number[] = [];
      for (let k = 1; k <= BASELINE_MONTHS; k++) {
        const h = addMonths(m, -k);
        if (h >= start) history.push(byMonth.get(h) ?? 0);
      }
      if (history.length < MIN_HISTORY) continue;
      const mean = history.reduce((a, b) => a + b, 0) / history.length;
      const limit = mean + 3 * Math.sqrt(mean);
      // The limit is shown rounded down, so a marked count is always visibly above it.
      if (n > limit) out.push({ key, month: m, n, mean: Math.round(mean * 10) / 10, limit: Math.floor(limit * 10) / 10 });
    }
  }
  return out;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const STEP: Record<string, string> = {
  classification: 'Awaiting classification', approval: 'Awaiting approval', investigation: 'Investigation',
  closure: 'Awaiting closure', closed: 'Closed', rejected: 'Rejected', open: 'Open', done: 'Done, awaiting QA', check: 'Effectiveness check due',
};
const MEANING: Record<string, string> = {
  approved: 'Approved', rejected: 'Rejected', investigation_complete: 'Investigation complete', verified: 'Verified', closed: 'Closed', reopened: 'Reopened',
};

// Reads one of this app's own JSON endpoints as the same user, so the PDF shows exactly what the screen shows.
async function asUser<T>(app: FastifyInstance, req: FastifyRequest, url: string): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: 'GET', url, headers: { cookie: req.headers.cookie ?? '', 'x-background-poll': '1' } });
  return { status: res.statusCode, body: res.json() as T };
}

const sendPdf = (reply: FastifyReply, name: string, pdf: Buffer) =>
  reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${name}.pdf"`).send(pdf);

type Row = Record<string, unknown>;
const val = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
type Names = { area: Map<number, string>; type: Map<number, string>; user: Map<number, string> };
// Ids in stored data are printed with their names, so every version is readable on its own (DV-21).
const NAMED: Record<string, [keyof Names, string]> = { areaId: ['area', 'area'], typeId: ['type', 'type'], investigatorId: ['user', 'investigator'], ownerId: ['user', 'owner'] };
const dataRows = (data: Row, names: Names): [string, unknown][] =>
  Object.entries(data).flatMap(([k, v]): [string, unknown][] => {
    // The fishbone prints one row per category that has text (D-26).
    if (k === 'fishbone' && v && typeof v === 'object') {
      return FISHBONE.filter(([key]) => (v as Row)[key]).map(([key, label]) => [`fishbone: ${label}`, val((v as Row)[key])]);
    }
    // S13 tools print readably (D-35).
    if (k === 'isIsNot' && v && typeof v === 'object') {
      return Object.entries(v as Record<string, Row>).map(([q, r]): [string, unknown] => [`is / is not: ${q}`, `is: ${val(r.is)} | is not: ${val(r.isNot)} | tells: ${val(r.tells)}`]);
    }
    if (k === 'sixM' && v && typeof v === 'object') {
      return FISHBONE.map(([key, label]): [string, unknown] => {
        const m = ((v as Row)[key] ?? {}) as Row;
        return [`6M: ${label}`, `${m.verdict === 'ruled_in' ? 'RULED IN' : m.verdict === 'ruled_out' ? 'ruled out' : '—'}. Checked: ${val(m.checked)}. Evidence: ${val(m.evidence)}`];
      });
    }
    if (k === 'fiveWhys' && v && typeof v === 'object') {
      const w = v as { problem?: unknown; whys?: Row[] };
      return [['5 whys: problem', val(w.problem)], ...(w.whys ?? []).map((x, i): [string, unknown] => [`why ${i + 1}`, `${val(x.answer)} (evidence: ${val(x.evidence)})`])];
    }
    // The initial impact assessment prints as readable answers (D-34).
    if (k === 'initialImpact' && v && typeof v === 'object') {
      const a = v as Row;
      const word = (x: unknown) => ({ yes: 'yes', no: 'no', unknown: 'not known' } as Record<string, string>)[String(x)] ?? val(x);
      return [['initial impact', `product quality ${word(a.productQuality)}; patient safety ${word(a.patientSafety)}; other batches ${word(a.otherBatches)}. ${val(a.notes)}`]];
    }
    const n = NAMED[k];
    return [n ? [n[1], `${names[n[0]].get(Number(v)) ?? '?'} (#${val(v)})`] : [k, val(v)]];
  });
async function loadNames(sql: Sql): Promise<Names> {
  const rows = async (q: Promise<{ id: number; name: string }[]>) => new Map((await q).map((r) => [r.id, r.name]));
  return {
    area: await rows(sql`select id::int, name from areas`),
    type: await rows(sql`select id::int, name from deviation_types`),
    user: await rows(sql`select id::int, full_name || ' (' || username || ')' as name from users`),
  };
}

export function reportRoutes(app: FastifyInstance, sql: Sql) {
  const reader = { preHandler: requireRole() };

  // DV-11: every deviation that names a batch, as its own batch or as an "other batch" checked, with status.
  app.get<{ Querystring: { batch?: string } }>('/api/batch-lookup', reader, async (req, reply) => {
    const norm = normaliseBatch((req.query.batch ?? '').slice(0, 80));
    if (!norm) return reply.code(400).send({ error: 'invalid_request', problems: ['Type a batch number.'] });
    return sql`
      select d.id::int, d.number, d.step, d.classification, to_char(d.target_date, 'YYYY-MM-DD') as "targetDate",
        r.data->>'title' as title, b.role, b.product, b.batch, b.outcome,
        (d.step not in ('closed', 'rejected')) as open,
        (select count(*)::int from capas c where c.deviation_id = d.id and c.step <> 'closed') as "openCapas"
      from batches b join latest_sections s on s.id = b.section_id
      join deviations d on d.id = b.deviation_id
      join latest_sections r on r.deviation_id = d.id and r.kind = 'report'
      where b.batch_norm = ${norm}
      order by (d.step not in ('closed', 'rejected')) desc, d.id desc`;
  });

  // DV-12: counts by month split by area, type or classification, for a period and product; CAPA counts too.
  app.get<{ Querystring: Record<string, string> }>('/api/trends', reader, async (req, reply) => {
    const q = trendQuery.safeParse(req.query);
    // At most 120 months, the span the screen shows.
    const span = q.success ? (Number(q.data.to.slice(0, 4)) - Number(q.data.from.slice(0, 4))) * 12 + Number(q.data.to.slice(5)) - Number(q.data.from.slice(5)) : -1;
    if (!q.success || span < 0 || span >= 120) return reply.code(400).send({ error: 'invalid_request', problems: ['Choose a period of at most 120 months, "from" before "to".'] });
    const { from, to, by, product } = q.data;
    const like = '%' + likeEscape(product) + '%';
    // Deviations reported in the period (plant months), optionally for a product (free text, D-12).
    const devsIn = (from: string, to: string) => sql`
      select d.id, d.classification, to_char(d.reported_at at time zone ${PLANT_TZ}, 'YYYY-MM') as month,
        a.name as area, ty.name as type
      from deviations d
      join latest_sections r on r.deviation_id = d.id and r.kind = 'report'
      left join areas a on a.id = (r.data->>'areaId')::bigint
      left join latest_sections c on c.deviation_id = d.id and c.kind = 'classification'
      left join deviation_types ty on ty.id = (c.data->>'typeId')::bigint
      where to_char(d.reported_at at time zone ${PLANT_TZ}, 'YYYY-MM') between ${from} and ${to}
        and (${product === ''} or exists (select 1 from batches b where b.section_id = r.id and b.product ilike ${like}))`;
    const key = by === 'area' ? sql`coalesce(area, '—')` : by === 'type' ? sql`coalesce(type, 'Not classified')` : sql`coalesce(classification, 'not classified')`;
    const countsIn = (f: string, t: string) => sql<{ key: string; month: string; n: number }[]>`
      select ${key} as key, month, count(*)::int as n from (${devsIn(f, t)}) x group by 1, 2 order by 1, 2`;
    // S10 (D-30): counted from 12 months before the period, so the first months have a baseline; the table shows the period.
    const all = await countsIn(addMonths(from, -BASELINE_MONTHS), to);
    const counts = all.filter((r) => r.month >= from);
    // Months before the site's first deviation are not history; quiet months after it count as 0.
    const [first] = await sql<{ m: string | null }[]>`select to_char(min(reported_at) at time zone ${PLANT_TZ}, 'YYYY-MM') as m from deviations`;
    const spikes = spikeFlags(all, from, to, first?.m ?? to);
    // Every spelling of the product that matched, so variants are seen and not silently missed (DV-12).
    const products = product === '' ? [] : (await sql<{ product: string; n: number }[]>`
      select b.product, count(distinct d.id)::int as n
      from deviations d join latest_sections r on r.deviation_id = d.id and r.kind = 'report'
      join batches b on b.section_id = r.id
      where to_char(d.reported_at at time zone ${PLANT_TZ}, 'YYYY-MM') between ${from} and ${to} and b.product ilike ${like}
      group by b.product order by b.product`);
    // CAPAs raised in the period; with a product filter, those of the matching deviations.
    const capas = await sql<{ source: string; step: string; outcome: string; n: number }[]>`
      select c.source, c.step,
        case when v.data->'checkResult'->>'effective' = 'true' then 'effective'
             when v.data->'checkResult'->>'effective' = 'false' then 'not_effective'
             when v.data->'effectiveness'->>'mode' = 'trend' then 'trend'
             else 'pending' end as outcome,
        count(*)::int as n
      from capas c join latest_capa_versions v on v.capa_id = c.id
      where to_char(c.raised_at at time zone ${PLANT_TZ}, 'YYYY-MM') between ${from} and ${to}
        -- With a product filter: CAPAs of any deviation of that product, also one reported before the period.
        and (${product === ''} or c.deviation_id in (select r.deviation_id from latest_sections r join batches b on b.section_id = r.id
                                                       where r.kind = 'report' and b.product ilike ${like}))
      group by 1, 2, 3`;
    // S14 (D-36): Pareto of root-cause categories in the period, and repeats: the same category 3 or more
    // times in the 6 months up to "to" (a system failure that needs a systemic CAPA).
    const byCategory = (f: string, t: string) => sql<{ category: string; n: number }[]>`
      select i.data->>'rootCauseCategory' as category, count(*)::int as n
      from (${devsIn(f, t)}) x join latest_sections i on i.deviation_id = x.id and i.kind = 'investigation'
      where i.data ? 'rootCauseCategory' group by 1 order by 2 desc, 1`;
    const pareto = await byCategory(from, to);
    const repeats = (await byCategory(addMonths(to, -5), to)).filter((r) => r.n >= 3);
    return { from, to, by, counts, products, capas, spikes, pareto, repeats };
  });

  // DV-21: one PDF per deviation: every section with all versions, signatures, CAPAs, attachments and history.
  app.get<{ Params: { id: string } }>('/api/deviations/:id/pdf', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const { status, body: d } = await asUser<Row & { sections: Row[]; signatures: Row[]; batches: Row[]; history: Row[]; attachments: Row[] }>(app, req, `/api/deviations/${id}`);
    if (status !== 200) return reply.code(status).send(d);
    const { body: capas } = await asUser<Row[]>(app, req, `/api/capas?deviationId=${id}&status=all`);
    const [s] = await sql<{ site_name: string }[]>`select site_name from settings`;
    const latestIds = new Set(d.sections.filter((x) => x.latest).map((x) => x.id));
    const names = await loadNames(sql);
    const content: Content[] = [
      t(`${d.number} · ${val((d.sections.find((x) => x.kind === 'report' && x.latest)?.data as Row)?.title)}`, { bold: true, fontSize: 14 }),
      fields([
        ['Status', STEP[String(d.step)]], ['Classification', d.classification], ['Planned', d.planned ? 'yes' : 'no'],
        ['Target date', d.targetDate], ['Overdue', d.overdue ? 'yes' : 'no'], ['Area', d.area],
        ['Reported by', `${val(d.reporter)} · ${plant(d.reportedAt as string)}`], ['Investigator', d.investigator], ['Open CAPAs', d.openCapas],
      ]),
      heading('Product and batches'),
      table(['Role', 'Product', 'Batch', 'Outcome'], d.batches.map((b) => [b.role === 'own' ? 'Concerned' : 'Other batch checked', b.product, b.batch, b.outcome ?? ''])),
    ];
    for (const kind of ['report', 'classification', 'investigation_draft', 'investigation', 'closure', 'target_date']) {
      const versions = d.sections.filter((x) => x.kind === kind);
      if (!versions.length) continue;
      content.push(heading({ report: 'Report', classification: 'Classification', investigation_draft: 'Investigation drafts (saved while investigating, not signed)', investigation: 'Investigation', closure: 'Closure', target_date: 'Target date changes' }[kind]!));
      for (const v of [...versions].reverse()) {
        // A draft is never current or superseded: it is a saved working copy (D-35).
        const state = kind === 'investigation_draft' ? ' (draft, not signed)' : latestIds.has(v.id) ? ' (current)' : ' (superseded by a correction)';
        content.push(t(`${kind === 'investigation_draft' ? 'Draft' : 'Version'} ${v.version}${state} · ${val(v.savedBy)} · ${plant(v.savedAt as string)}${v.reason ? ` · reason: ${v.reason}` : ''}`, { bold: true, fontSize: 8, margin: [0, 4, 0, 2] }));
        content.push(fields(dataRows(v.data as Row, names)));
        for (const g of d.signatures.filter((x) => x.sectionId === v.id)) {
          content.push(t(`Signed: ${MEANING[String(g.meaning)] ?? g.meaning} · ${val(g.printedName)} · ${plant(g.signedAt as string)}${latestIds.has(v.id) ? '' : ' (superseded)'}`, { fontSize: 8, margin: [0, 2, 0, 0] }));
        }
      }
    }
    content.push(heading('CAPAs'), table(['Number', 'Type', 'What', 'Owner', 'Status', 'Due'], capas.map((c) => [c.number, c.type, c.description, c.owner, STEP[String(c.step)], c.dueDate]), [60, 50, '*', 70, 70, 50]));
    content.push(heading('Attachments'), table(['File', 'Size', 'SHA-256', 'By', 'When', 'Withdrawn'], d.attachments.map((a) => [a.filename, a.size, a.sha256, a.uploadedBy, plant(a.uploadedAt as string), a.withdrawnReason ?? '']), ['*', 30, 120, 50, 60, 60]));
    content.push(heading('History (audit trail)'), table(['When', 'Who', 'What', 'Old', 'New', 'Reason'], d.history.map((h) => [plant(h.at as string), h.actor ?? 'System', h.action, val(h.oldValue), val(h.newValue), h.reason ?? '']), [60, 50, 60, '*', '*', 60]));
    return sendPdf(reply, String(d.number), await render(s!.site_name, `Deviation ${d.number}`, req.user!.fullName, content));
  });

  // DV-21: one PDF per CAPA: every version, signatures and history.
  app.get<{ Params: { id: string } }>('/api/capas/:id/pdf', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const { status, body: c } = await asUser<Row & { versions: Row[]; signatures: Row[]; history: Row[] }>(app, req, `/api/capas/${id}`);
    if (status !== 200) return reply.code(status).send(c);
    const [s] = await sql<{ site_name: string }[]>`select site_name from settings`;
    const content: Content[] = [
      t(String(c.number), { bold: true, fontSize: 14 }),
      fields([
        ['Status', STEP[String(c.step)]], ['Source', c.source === 'deviation' ? `Deviation ${val(c.deviationNumber)}` : `${val(c.source)}: ${val(c.sourceRef)}`],
        ['Owner', c.owner], ['Due date', c.dueDate], ['Check due', c.checkDue], ['Overdue', c.overdue ? 'yes' : 'no'],
        ['Raised by', `${val(c.raisedBy)} · ${plant(c.raisedAt as string)}`],
      ]),
      heading('Versions'),
    ];
    const names = await loadNames(sql);
    const current = Math.max(...c.versions.map((v) => Number(v.version)));
    for (const v of [...c.versions].reverse()) {
      // Each version adds to the one before; the highest is in force, earlier ones are kept as history.
      const isCurrent = Number(v.version) === current;
      content.push(t(`Version ${v.version}${isCurrent ? ' (current)' : ' (superseded)'} · ${v.action} · ${val(v.savedBy)} · ${plant(v.savedAt as string)}${v.reason ? ` · reason: ${v.reason}` : ''}`, { bold: true, fontSize: 8, margin: [0, 4, 0, 2] }));
      content.push(fields(dataRows(v.data as Row, names)));
      for (const g of c.signatures.filter((x) => x.versionId === v.id)) {
        content.push(t(`Signed: ${MEANING[String(g.meaning)] ?? g.meaning} · ${val(g.printedName)} · ${plant(g.signedAt as string)}`, { fontSize: 8, margin: [0, 2, 0, 0] }));
      }
    }
    content.push(heading('History (audit trail)'), table(['When', 'Who', 'What', 'Old', 'New', 'Reason'], c.history.map((h) => [plant(h.at as string), h.actor ?? 'System', h.action, val(h.oldValue), val(h.newValue), h.reason ?? '']), [60, 50, 60, '*', '*', 60]));
    return sendPdf(reply, String(c.number), await render(s!.site_name, `CAPA ${c.number}`, req.user!.fullName, content));
  });
}
