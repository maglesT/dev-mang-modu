import { z } from 'zod';
import type { Sql, Tx } from './db.js';

// Plant time zone for dates (target dates, overdue); storage stays UTC (DV-16).
export const PLANT_TZ = 'Asia/Kolkata';
export const CLASSIFICATIONS = ['minor', 'major', 'critical'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export type Step = 'classification' | 'approval' | 'investigation' | 'closure' | 'closed' | 'rejected';

const text = (max: number) => z.string().trim().min(1).max(max);
// Lower case without spaces, dashes, slashes or dots: "B-123/A" and "b123a" match (DV-11).
export const normaliseBatch = (b: string) => b.toLowerCase().replace(/[\s\-/._]+/g, '');

const productBatch = z.object({
  product: text(200),
  batch: text(80).refine((b) => normaliseBatch(b).length > 0, 'A batch number needs letters or digits.'),
});

// DV-01: the report. Product and batch are free text (owner default); "none" must be said explicitly.
export const reportData = z
  .object({
    planned: z.boolean(),
    title: text(200),
    description: text(5000),
    areaId: z.number().int().positive(),
    equipment: z.string().trim().max(200).default(''),
    eventAt: z.string().datetime({ offset: true }),
    products: z.array(productBatch).max(20),
    noBatch: z.boolean().default(false),
    immediateAction: text(5000),
    // DV-01 / 211.100(b): a planned deviation is justified before it happens.
    plannedReason: z.string().trim().max(5000).default(''),
  })
  .superRefine((d, ctx) => {
    if (d.products.length === 0 && !d.noBatch) ctx.addIssue({ code: 'custom', path: ['products'], message: 'Give the product and batch, or tick "no product or batch concerned".' });
    if (d.products.length > 0 && d.noBatch) ctx.addIssue({ code: 'custom', path: ['noBatch'], message: 'Either list products and batches or tick "none", not both.' });
    if (d.planned && !d.plannedReason) ctx.addIssue({ code: 'custom', path: ['plannedReason'], message: 'Give the reason for the planned deviation.' });
    // DV-13: the event cannot be in the future (2 minutes allowed for clock differences).
    if (new Date(d.eventAt).getTime() > Date.now() + 120_000) ctx.addIssue({ code: 'custom', path: ['eventAt'], message: 'When it happened cannot be in the future.' });
  });
export type ReportData = z.infer<typeof reportData>;

// DV-03, DV-20: QA's classification, including the independent check of product and batch.
export const classificationData = z.object({
  classification: z.enum(CLASSIFICATIONS),
  typeId: z.number().int().positive(),
  impact: text(5000),
  investigatorId: z.number().int().positive(),
  productBatchChecked: z.literal(true, { errorMap: () => ({ message: 'Confirm that product and batch were checked.' }) }),
});
export type ClassificationData = z.infer<typeof classificationData>;

export async function writeBatches(tx: Tx, deviationId: number, sectionId: number, rows: { product: string; batch: string; role: 'own' | 'other'; outcome?: string | null }[]) {
  for (const r of rows) {
    await tx`insert into batches (section_id, deviation_id, role, product, batch, batch_norm, outcome)
      values (${sectionId}, ${deviationId}, ${r.role}, ${r.product}, ${r.batch}, ${normaliseBatch(r.batch)}, ${r.outcome ?? null})`;
  }
}

// Adds a section version (DV-14). The first version needs no reason; later ones do (checked by the DB too).
export async function addSection(tx: Tx, deviationId: number, kind: string, data: unknown, userId: number, reason: string | null = null) {
  const [prev] = await tx<{ id: number; version: number }[]>`
    select id::int, version from latest_sections where deviation_id = ${deviationId} and kind = ${kind}`;
  const [row] = await tx<{ id: number; version: number }[]>`
    insert into sections (deviation_id, kind, version, data, saved_by, reason, supersedes)
    values (${deviationId}, ${kind}, ${(prev?.version ?? 0) + 1}, ${tx.json(data as never)}, ${userId}, ${reason}, ${prev?.id ?? null})
    returning id::int, version`;
  return row!;
}

// Target closure date from the report date (plant time) and the classification (D-10).
export async function targetDate(tx: Tx | Sql, deviationId: number, classification: Classification): Promise<string> {
  const [s] = await tx<{ minor: number; major: number; critical: number }[]>`
    select target_days_minor as minor, target_days_major as major, target_days_critical as critical from settings`;
  const [r] = await tx<{ d: string }[]>`
    select to_char((reported_at at time zone ${PLANT_TZ})::date + ${s![classification]}::int, 'YYYY-MM-DD') as d
    from deviations where id = ${deviationId}`;
  return r!.d;
}

// SQL fragment: overdue = past the target date in plant time and still open.
export const overdueSql = (sql: Sql) =>
  sql`(d.target_date is not null and d.target_date < (now() at time zone ${PLANT_TZ})::date and d.step not in ('closed', 'rejected'))`;

// DV-04 to DV-07: the investigation, signed by the investigator.
export const investigationData = z
  .object({
    rootCause: text(5000),
    // DV-04 / SchM 1.5(s): the true root cause could not be confirmed; the most likely one is stated.
    mostLikely: z.boolean().default(false),
    humanError: z.boolean().default(false),
    humanErrorJustification: z.string().trim().max(5000).default(''),
    // DV-06 / 211.192: other batches and products checked, or why none could be associated.
    otherBatches: z.array(productBatch.extend({ outcome: z.enum(['affected', 'not_affected']) })).max(50),
    noOtherReason: z.string().trim().max(2000).default(''),
    conclusion: text(5000),
  })
  .superRefine((d, ctx) => {
    if (d.humanError && !d.humanErrorJustification) ctx.addIssue({ code: 'custom', path: ['humanErrorJustification'], message: 'Explain why human error is the cause and how process, procedure or system causes were ruled out.' });
    if (d.otherBatches.length === 0 && !d.noOtherReason) ctx.addIssue({ code: 'custom', path: ['otherBatches'], message: 'List the other batches or products checked, or say why none could be affected.' });
  });
export type InvestigationData = z.infer<typeof investigationData>;
