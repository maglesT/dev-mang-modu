import { z } from 'zod';
import type { Sql, Tx } from './db.js';
import { contentHash } from './signatures.js';

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

// S12 (D-34): the reporter's initial impact assessment: three quick answers and a short note.
const answer = (what: string) => z.enum(['yes', 'no', 'unknown'], { errorMap: () => ({ message: `Initial impact: answer "${what}" (yes, no or not known).` }) });
export const initialImpactData = z.object({
  productQuality: answer('product quality affected?'),
  patientSafety: answer('patient safety at risk?'),
  otherBatches: answer('other batches possibly affected?'),
  notes: z.string().trim().min(1, 'Initial impact: write a short assessment.').max(3000),
}, { errorMap: () => ({ message: 'Give the initial impact assessment.' }) });

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
    // S12: when the immediate action was taken (optional; never in the future).
    actionTakenAt: z.string().datetime({ offset: true }).nullable().default(null),
    initialImpact: initialImpactData,
    // DV-01 / 211.100(b): a planned deviation is justified before it happens.
    plannedReason: z.string().trim().max(5000).default(''),
  })
  .superRefine((d, ctx) => {
    if (d.products.length === 0 && !d.noBatch) ctx.addIssue({ code: 'custom', path: ['products'], message: 'Give the product and batch, or tick "no product or batch concerned".' });
    if (d.products.length > 0 && d.noBatch) ctx.addIssue({ code: 'custom', path: ['noBatch'], message: 'Either list products and batches or tick "none", not both.' });
    if (d.planned && !d.plannedReason) ctx.addIssue({ code: 'custom', path: ['plannedReason'], message: 'Give the reason for the planned deviation.' });
    // DV-13: the event cannot be in the future (2 minutes allowed for clock differences).
    if (new Date(d.eventAt).getTime() > Date.now() + 120_000) ctx.addIssue({ code: 'custom', path: ['eventAt'], message: 'When it happened cannot be in the future.' });
    if (d.actionTakenAt && new Date(d.actionTakenAt).getTime() > Date.now() + 120_000) ctx.addIssue({ code: 'custom', path: ['actionTakenAt'], message: 'When the action was taken cannot be in the future.' });
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

// Fishbone (Ishikawa) categories: possible causes considered per category (owner decision D-26). Optional;
// older investigations without it read as empty. Saved and signed with the investigation.
export const FISHBONE = [
  ['man', 'People'], ['machine', 'Machine / equipment'], ['method', 'Method'],
  ['material', 'Material'], ['measurement', 'Measurement'], ['environment', 'Environment'],
] as const;
const cause = z.string().trim().max(2000).default('');
export const fishboneData = z.object({ man: cause, machine: cause, method: cause, material: cause, measurement: cause, environment: cause });

// S13 (D-33, D-35): investigation tools, required on every deviation (owner's house method).
// Every text field names itself in its message, so the investigator sees exactly what is missing.
const req = (label: string, max = 2000) =>
  z.string({ required_error: `${label}: required.`, invalid_type_error: `${label}: required.` }).trim().min(1, `${label}: required.`).max(max, `${label}: too long.`);
export const ROOT_CAUSE_CATEGORIES = ['system', 'process', 'human', 'equipment', 'material', 'environment'] as const;
export const IS_IS_NOT = [['what', 'What'], ['where', 'Where'], ['when', 'When'], ['who', 'Who'], ['extent', 'Extent']] as const;
const isRow = (q: string) => z.object({ is: req(`Is / Is Not, ${q}: is`, 1000), isNot: req(`Is / Is Not, ${q}: is not`, 1000), tells: req(`Is / Is Not, ${q}: what it tells`, 1000) },
  { required_error: `Is / Is Not, ${q}: required.` });
export const isIsNotData = z.object({ what: isRow('what'), where: isRow('where'), when: isRow('when'), who: isRow('who'), extent: isRow('extent') },
  { required_error: 'Is / Is Not: required.' });
const mCheck = (m: string) => z.object({
  checked: req(`6M, ${m}: what was checked`),
  evidence: req(`6M, ${m}: evidence`),
  verdict: z.enum(['ruled_in', 'ruled_out'], { errorMap: () => ({ message: `6M, ${m}: ruled in or ruled out?` }) }),
}, { required_error: `6M, ${m}: required.` });
export const sixMData = z.object({
  man: mCheck('People'), machine: mCheck('Machine / equipment'), method: mCheck('Method'),
  material: mCheck('Material'), measurement: mCheck('Measurement'), environment: mCheck('Environment'),
}, { required_error: '6M fishbone: required.' }).refine((m) => Object.values(m).some((x) => x.verdict === 'ruled_in'),
  { message: '6M: at least one M must be ruled in (the root cause sits there).' });
export const fiveWhysData = z.object({
  problem: req('5 Whys: problem statement', 1000),
  whys: z.array(z.object({ answer: req('5 Whys: answer', 1000), evidence: req('5 Whys: evidence', 1000) }))
    .min(3, '5 Whys: at least 3 whys, each with evidence.').max(7, '5 Whys: at most 7 whys.'),
}, { required_error: '5 Whys: required.' });

// DV-04 to DV-07: the investigation, signed by the investigator.
export const investigationData = z
  .object({
    isIsNot: isIsNotData,
    sixM: sixMData,
    fiveWhys: fiveWhysData,
    rootCauseCategory: z.enum(ROOT_CAUSE_CATEGORIES, { errorMap: () => ({ message: 'Choose the root-cause category.' }) }),
    // S7 fishbone text of investigations signed before S13; new investigations use sixM.
    fishbone: fishboneData.optional(),
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
// A draft is the form as it stands: any shape, kept small. It is never signed and never counts for the step.
export const investigationDraft = z.record(z.unknown()).refine((d) => JSON.stringify(d).length <= 200_000, 'The draft is too large.');
export type InvestigationData = z.infer<typeof investigationData>;

export const latestId = async (tx: Tx | Sql, id: number, kind: string) =>
  (await tx<{ id: number }[]>`select id::int from latest_sections where deviation_id = ${id} and kind = ${kind}`)[0]?.id;
export const isSigned = async (tx: Tx | Sql, sectionId: number | undefined, meaning: string) =>
  sectionId !== undefined && (await tx`select 1 from signatures where object_type = 'section' and object_id = ${sectionId} and meaning = ${meaning}`).length > 0;

// The planned-deviation approval covers the report and the classification (S2). It stays valid only while
// both are unchanged: the stored hash must match the hash of the current versions (DV-14, DV-16).
async function approvalValid(tx: Tx, id: number): Promise<boolean> {
  const rows = await tx<{ id: number; kind: string; data: unknown }[]>`
    select id::int, kind, data from latest_sections where deviation_id = ${id} and kind in ('report', 'classification')`;
  const report = rows.find((r) => r.kind === 'report');
  const classification = rows.find((r) => r.kind === 'classification');
  if (!classification) return false;
  const [s] = await tx<{ content_hash: string }[]>`
    select content_hash from signatures where object_type = 'section' and object_id = ${classification.id} and meaning = 'approved'`;
  return s?.content_hash === contentHash('section', classification.id, { report: report?.data, classification: classification.data });
}

// The step a deviation is in after its sections changed (DV-14: a correction supersedes earlier signatures).
export async function recomputeStep(tx: Tx, d: { id: number; planned: boolean; step: Step }): Promise<Step> {
  if (d.step === 'closed' || d.step === 'rejected') return d.step;
  const classification = await latestId(tx, d.id, 'classification');
  if (!classification) return 'classification';
  if (d.planned && !(await approvalValid(tx, d.id))) return 'approval';
  const investigation = await latestId(tx, d.id, 'investigation');
  if (!(await isSigned(tx, investigation, 'investigation_complete'))) return 'investigation';
  return 'closure';
}

