import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db.js';
import { parseId, requireRole } from '../auth.js';
import { FISHBONE, normaliseBatch } from '../deviations.js';

// S8 (D-27): fixed, explainable rules that point the investigator at repeats and at earlier root causes.
// Advice only: nothing here is saved, signed or required. Values are compared as text, never cast.
const WINDOW_DAYS = 90;
const LATE_REPORT_DAYS = 3;
const NOT_A_PRODUCT = new Set(['none', 'na', 'n/a', 'nil', '-']);
const STOP = new Set(['with', 'from', 'that', 'this', 'were', 'was', 'have', 'been', 'during', 'after', 'before', 'found', 'into', 'than', 'then', 'over', 'under', 'line', 'batch']);
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)));
const normEquipment = (s: string) => normaliseBatch(s);
const days = (ms: number) => ms / 86_400_000;

export interface Flag { kind: string; text: string; deviations: { id: number; number: string; title: string }[] }
export interface SimilarCase {
  id: number; number: string; title: string; step: string; why: string[];
  rootCause: string; humanError: boolean; causes: { category: string; text: string }[];
  capas: { number: string; description: string; step: string }[];
}
export interface Signals { flags: Flag[]; similar: SimilarCase[] }

interface Candidate {
  id: number; number: string; step: string; reported_at: Date; title: string;
  same_area: boolean; same_type: boolean; same_equipment: boolean; same_product: boolean; same_batch: boolean;
  root_cause: string | null; fishbone: Record<string, string> | null; human_error: boolean;
}

export async function computeSignals(sql: Sql, id: number): Promise<Signals | null> {
  const [me] = await sql<{ reported_at: Date; report: Record<string, unknown>; type_id: string | null; area: string | null; type: string | null }[]>`
    select d.reported_at, r.data as report, c.data->>'typeId' as type_id, a.name as area, t.name as type
    from deviations d join latest_sections r on r.deviation_id = d.id and r.kind = 'report'
    left join latest_sections c on c.deviation_id = d.id and c.kind = 'classification'
    left join areas a on a.id::text = r.data->>'areaId'
    left join deviation_types t on t.id::text = c.data->>'typeId'
    where d.id = ${id}`;
  if (!me) return null;
  const own = await sql<{ product: string; batch: string; batch_norm: string }[]>`
    select b.product, b.batch, b.batch_norm from batches b join latest_sections s on s.id = b.section_id
    where b.deviation_id = ${id} and b.role = 'own'`;
  const areaId = String(me.report.areaId ?? '');
  const equipment = String(me.report.equipment ?? '').trim();
  const eqNorm = normEquipment(equipment);
  const products = [...new Set(own.map((b) => b.product.trim().toLowerCase()).filter((p) => p && !NOT_A_PRODUCT.has(p)))];
  const batches = [...new Set(own.map((b) => b.batch_norm).filter(Boolean))];

  // Other deviations sharing at least one thing with this one (newest first, capped for speed).
  const cands = await sql<Candidate[]>`
    select * from (
      select d.id::int, d.number, d.step, d.reported_at, r.data->>'title' as title,
        (r.data->>'areaId') = ${areaId} as same_area,
        (${me.type_id ?? ''} <> '' and c.data->>'typeId' = ${me.type_id ?? ''}) as same_type,
        (${eqNorm} <> '' and lower(regexp_replace(coalesce(r.data->>'equipment', ''), '[\\s\\-/._]+', '', 'g')) = ${eqNorm}) as same_equipment,
        exists (select 1 from batches b join latest_sections s on s.id = b.section_id
                where b.deviation_id = d.id and b.role = 'own' and lower(trim(b.product)) = any(${products})) as same_product,
        exists (select 1 from batches b join latest_sections s on s.id = b.section_id
                where b.deviation_id = d.id and b.batch_norm = any(${batches})) as same_batch,
        i.data->>'rootCause' as root_cause, i.data->'fishbone' as fishbone, coalesce(i.data->>'humanError' = 'true', false) as human_error
      from deviations d
      join latest_sections r on r.deviation_id = d.id and r.kind = 'report'
      left join latest_sections c on c.deviation_id = d.id and c.kind = 'classification'
      left join latest_sections i on i.deviation_id = d.id and i.kind = 'investigation'
      where d.id <> ${id} and d.step <> 'rejected'
    ) x
    where same_area or same_type or same_equipment or same_product or same_batch
    order by id desc limit 300`;

  const near = (c: Candidate) => Math.abs(days(c.reported_at.getTime() - me.reported_at.getTime())) <= WINDOW_DAYS;
  const ref = (c: Candidate) => ({ id: c.id, number: c.number, title: c.title });
  const flags: Flag[] = [];
  const add = (kind: string, list: Candidate[], min: number, text: (n: number) => string) => {
    if (list.length >= min) flags.push({ kind, text: text(list.length), deviations: list.slice(0, 10).map(ref) });
  };
  const other = (n: number) => (n === 1 ? '1 other deviation' : `${n} other deviations`);
  add('batch', cands.filter((c) => c.same_batch), 1, (n) =>
    `This batch is also named in ${other(n)}. Look at them together: they may have the same cause, and all of them matter for releasing the batch.`);
  add('equipment', cands.filter((c) => c.same_equipment && near(c)), 1, (n) =>
    `The same equipment (${equipment}) had ${other(n)} within ${WINDOW_DAYS} days. A repeat on one machine often points to the machine, its set-up or its maintenance.`);
  add('product', cands.filter((c) => c.same_product && near(c)), 1, (n) =>
    `The same product had ${other(n)} within ${WINDOW_DAYS} days. Check whether the product, its materials or its method could be the common cause.`);
  add('type', cands.filter((c) => c.same_type && near(c)), 2, (n) =>
    `${other(n)} of the same type (${me.type}) within ${WINDOW_DAYS} days. This may be a repeating problem: check whether earlier CAPAs worked.`);
  add('area', cands.filter((c) => c.same_area && near(c)), 2, (n) =>
    `${other(n)} in the same area (${me.area}) within ${WINDOW_DAYS} days. Look for something the area has in common.`);
  add('human_error', cands.filter((c) => c.same_area && near(c) && c.human_error), 2, (n) =>
    `Human error was named as the cause ${n} times in this area within ${WINDOW_DAYS} days. When it keeps happening, the cause is often the procedure, training or workload, not the person.`);
  const eventAt = Date.parse(String(me.report.eventAt ?? ''));
  const late = days(me.reported_at.getTime() - eventAt);
  if (late > LATE_REPORT_DAYS) {
    flags.push({ kind: 'late_report', deviations: [], text: `Reported ${Math.floor(late)} days after it happened. Find out why it was not reported at once, and whether anything made in between could be affected.` });
  }

  // Similar earlier cases with a written root cause: shared things score, highest first.
  const mine = words(String(me.report.title ?? '') + ' ' + String(me.report.description ?? ''));
  const scored = cands.filter((c) => c.root_cause).map((c) => {
    const why: string[] = [];
    let score = 0;
    if (c.same_type) { score += 3; why.push('same type'); }
    if (c.same_equipment) { score += 3; why.push('same equipment'); }
    if (c.same_batch) { score += 3; why.push('same batch'); }
    if (c.same_product) { score += 2; why.push('same product'); }
    if (c.same_area) { score += 1; why.push('same area'); }
    const shared = [...words(c.title)].filter((w) => mine.has(w));
    if (shared.length) { score += shared.length; why.push(`similar words: ${shared.slice(0, 4).join(', ')}`); }
    return { c, score, why };
  }).filter((s) => s.score >= 3).sort((a, b) => b.score - a.score || b.c.id - a.c.id).slice(0, 5);

  const capaRows = scored.length ? await sql<{ deviation_id: number; number: string; description: string; step: string }[]>`
    select c.deviation_id::int, c.number, v.data->>'description' as description, c.step
    from capas c join latest_capa_versions v on v.capa_id = c.id
    where c.deviation_id = any(${scored.map((s) => s.c.id)}) order by c.id` : [];
  const similar: SimilarCase[] = scored.map(({ c, why }) => ({
    id: c.id, number: c.number, title: c.title, step: c.step, why,
    rootCause: c.root_cause ?? '', humanError: c.human_error,
    causes: FISHBONE.map(([k, label]) => ({ category: label, text: String(c.fishbone?.[k] ?? '').trim() })).filter((x) => x.text),
    capas: capaRows.filter((r) => r.deviation_id === c.id).map((r) => ({ number: r.number, description: r.description, step: r.step })),
  }));
  return { flags, similar };
}

export function signalRoutes(app: FastifyInstance, sql: Sql) {
  // Same readers as the deviation page.
  app.get<{ Params: { id: string } }>('/api/deviations/:id/signals', { preHandler: requireRole('user', 'qa') }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const s = await computeSignals(sql, id);
    return s ?? reply.code(404).send({ error: 'not_found' });
  });
}
