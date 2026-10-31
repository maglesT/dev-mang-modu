import type { Query, Source } from './logbook.js';

// S17 (D-37, DV-23): reads Batchwright's read-only report views as the role ebmr_report (contract:
// docs/07-data-contracts.md). Never Batchwright's deviation module, never a write. Text comparisons only.
export const BATCHWRIGHT_VIEWS = ['batch_fact_v1', 'step_use_v1', 'cpp_value_v1', 'exception_v1', 'alarm_v1', 'batch_reference_v1',
  'equipment_use_v1', 'ipc_result_v1', 'process_actual_v1', 'exception_detail_v1'];
// S18 (D-38): views added by Batchwright's S16 PR. Read when present, so the reader works before and after it is deployed.
const OPTIONAL = ['batch_reference_v1', 'equipment_use_v1', 'ipc_result_v1', 'process_actual_v1', 'exception_detail_v1'];

export interface BatchwrightData {
  batches: { batch_number: string; product_code: string | null; strength: string | null; family_code: string | null; status: string; issued_at: string | null; completed_at: string | null; released: boolean }[];
  steps: { batch_number: string; step: string; step_id: string | null; equipment_code: string | null; equipment_type: string | null; room_code: string | null;
    started_at: string | null; ended_at: string | null; material_lots: { lot: string; supplier: string | null }[] }[];
  values: { batch_number: string; kind: string; item: string; step: string; attempt: number | null; reading: number | null; role: string | null; value_text: string | null; unit: string | null;
    lower_text: string | null; upper_text: string | null; target_text: string | null; limit_tier: string | null; failed: boolean; recorded_at: string | null }[];
  exceptions: { batch_number: string; exception_id: string; exception_type: string; category: string | null; severity: string | null; raised_at: string | null }[];
  alarms: { alarm_code: string; source: string | null; gmp_critical: boolean; subject_kind: string | null; subject_code: string | null; raised_at: string | null; acked_at: string | null; batch_numbers: string[] }[];
  references: { batch_number: string; kind: string; code: string; version: string | null; title: string | null }[];
  equipmentUse: { batch_number: string; equipment_code: string; equipment_type: string | null; room_code: string | null; step: string | null; started_at: string | null; ended_at: string | null }[];
  ipc: { batch_number: string; step: string; step_title: string | null; check_kind: string | null; item: string; instrument_code: string | null; reading: number | null; value_text: string | null;
    unit: string | null; lower_text: string | null; upper_text: string | null; aggregate: string | null; alert_lower_text: string | null; alert_upper_text: string | null; result: string | null; recorded_at: string | null }[];
  actuals: { batch_number: string; step: string; tag: string; value_text: string | null; unit: string | null; lower_text: string | null; upper_text: string | null; within_limits: boolean | null; recorded_at: string | null }[];
  exceptionDetails: { batch_number: string; exception_id: string; exception_type: string; category: string | null; severity: string | null; step: string | null; step_title: string | null;
    description: string | null; status: string | null; disposition: string | null; disposed_by: string | null; disposed_at: string | null; raised_at: string | null }[];
  viewsRead: string[];
  equipmentUsed: string[];
  readAt: string;
  dataAsOf: string | null;
}

const norm = (col: string) => `lower(regexp_replace(coalesce(${col}, ''), '[\\s\\-/._]+', '', 'g'))`;

export async function readBatchwright(src: Source, q: Query): Promise<BatchwrightData> {
  const s = src.sql;
  const v = (name: string) => s(`${src.schema}.${name}`);
  if (!q.batchesNorm.length) {
    const [now] = await s<{ at: string }[]>`select now() as at`;
    return { batches: [], steps: [], values: [], exceptions: [], alarms: [], references: [], equipmentUse: [], ipc: [], actuals: [], exceptionDetails: [], viewsRead: [], equipmentUsed: [], readAt: now!.at, dataAsOf: null };
  }
  return s.begin('read only', async (tx) => {
    await tx`set local statement_timeout = '15s'`;
    const b = tx.unsafe(norm('batch_number'));
    const batches = await tx<BatchwrightData['batches']>`
      select batch_number, product_code, strength, family_code, status, issued_at, completed_at, released
      from ${v('batch_fact_v1')} where ${b} = any(${q.batchesNorm}) order by issued_at`;
    const steps = await tx<BatchwrightData['steps']>`
      select batch_number, step, step_id, nullif(equipment_code, '') as equipment_code, nullif(equipment_type, '') as equipment_type,
        nullif(room_code, '') as room_code, started_at, ended_at, coalesce(material_lots, '[]'::jsonb) as material_lots
      from ${v('step_use_v1')} where ${b} = any(${q.batchesNorm}) order by batch_number, started_at nulls last limit 1000`;
    const values = await tx<BatchwrightData['values']>`
      select batch_number, kind, item, step, attempt, reading, role, value_text, unit, lower_text, upper_text, target_text, limit_tier, failed, recorded_at
      from ${v('cpp_value_v1')} where ${b} = any(${q.batchesNorm}) order by batch_number, recorded_at nulls last, step, item, reading limit 3000`;
    const exceptions = await tx<BatchwrightData['exceptions']>`
      select batch_number, exception_id, exception_type, category, severity, raised_at
      from ${v('exception_v1')} where ${b} = any(${q.batchesNorm}) order by raised_at limit 500`;
    const alarms = await tx<BatchwrightData['alarms']>`
      select alarm_code, source, gmp_critical, subject_kind, subject_code, raised_at, acked_at, coalesce(batch_numbers, '{}') as batch_numbers
      from ${v('alarm_v1')} a
      where exists (select 1 from unnest(a.batch_numbers) n where ${tx.unsafe(norm('n'))} = any(${q.batchesNorm}))
      order by raised_at limit 200`;
    // Which of the newer views this Batchwright has (to_regclass needs no rights on the view itself).
    const present = new Set((await tx<{ name: string }[]>`
      select n as name from unnest(${OPTIONAL}::text[]) n where to_regclass(${src.schema} || '.' || n) is not null`).map((r) => r.name));
    const has = (name: string) => present.has(name);
    const references = has('batch_reference_v1') ? await tx<BatchwrightData['references']>`
      select batch_number, kind, code, version, title from ${v('batch_reference_v1')} where ${b} = any(${q.batchesNorm}) order by batch_number, kind, code limit 200` : [];
    const equipmentUse = has('equipment_use_v1') ? await tx<BatchwrightData['equipmentUse']>`
      select batch_number, equipment_code, equipment_type, room_code, step, started_at, ended_at
      from ${v('equipment_use_v1')} where ${b} = any(${q.batchesNorm}) order by batch_number, started_at nulls last limit 1000` : [];
    const ipc = has('ipc_result_v1') ? await tx<BatchwrightData['ipc']>`
      select batch_number, step, step_title, check_kind, item, instrument_code, reading, value_text, unit, lower_text, upper_text, aggregate,
        alert_lower_text, alert_upper_text, result, recorded_at
      from ${v('ipc_result_v1')} where ${b} = any(${q.batchesNorm}) order by batch_number, recorded_at nulls last, step, item, aggregate nulls first, reading limit 3000` : [];
    const actuals = has('process_actual_v1') ? await tx<BatchwrightData['actuals']>`
      select batch_number, step, tag, value_text, unit, lower_text, upper_text, within_limits, recorded_at
      from ${v('process_actual_v1')} where ${b} = any(${q.batchesNorm}) order by batch_number, recorded_at nulls last, step, tag limit 3000` : [];
    const exceptionDetails = has('exception_detail_v1') ? await tx<BatchwrightData['exceptionDetails']>`
      select batch_number, exception_id, exception_type, category, severity, step, step_title, description, status, disposition, disposed_by, disposed_at, raised_at
      from ${v('exception_detail_v1')} where ${b} = any(${q.batchesNorm}) order by raised_at limit 500` : [];
    const viewsRead = ['batch_fact_v1', 'step_use_v1', 'cpp_value_v1', 'exception_v1', 'alarm_v1', ...OPTIONAL.filter(has)];
    const [asOf] = await tx<{ at: string | null }[]>`select greatest(
      (select max(data_as_of) from ${v('batch_fact_v1')} where ${b} = any(${q.batchesNorm})),
      (select max(data_as_of) from ${v('cpp_value_v1')} where ${b} = any(${q.batchesNorm}))) as at`;
    const [now] = await tx<{ at: string }[]>`select now() as at`;
    // Equipment the batch used: the equipment-use view where present (step_use_v1 may have none), plus the IPC instruments.
    const equipmentUsed = [...new Set([...equipmentUse.map((x) => x.equipment_code), ...steps.map((x) => x.equipment_code), ...ipc.map((x) => x.instrument_code)]
      .filter((x): x is string => !!x))];
    return { batches, steps, values, exceptions, alarms, references, equipmentUse, ipc, actuals, exceptionDetails, viewsRead, equipmentUsed, readAt: now!.at, dataAsOf: asOf?.at ?? null };
  });
}

const num = (t: string | null) => (t !== null && t.trim() !== '' && Number.isFinite(Number(t)) ? Number(t) : null);
const fmt = (x: number) => String(Math.round(x * 100) / 100);

// Plain-words findings for the investigator (advice; the copy is the evidence).
export function batchwrightFindings(d: BatchwrightData): string[] {
  const out: string[] = [];
  if (!d.batches.length) out.push('No batch with this number was found in Batchwright.');
  for (const b of d.batches) out.push(`${b.batch_number} (${b.product_code ?? 'product ?'}): status ${b.status.toLowerCase().replace(/_/g, ' ')}${b.released ? ', released' : ', not released'}.`);
  // Values outside their limits, grouped per batch, item and step.
  const groups = new Map<string, BatchwrightData['values']>();
  for (const x of d.values.filter((x) => x.kind === 'PARAMETER')) {
    const k = `${x.batch_number}|${x.item}|${x.step}`;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  for (const [k, xs] of groups) {
    const [batch, item, step] = k.split('|');
    const lo = num(xs[0]!.lower_text);
    const hi = num(xs[0]!.upper_text);
    const unit = xs[0]!.unit ?? '';
    const limits = lo !== null || hi !== null ? ` (limits ${lo ?? '–'} to ${hi ?? '–'} ${unit})` : '';
    // Each reading against its own limits; Batchwright marks every reading of a failed check, so only the
    // readings actually outside their limits are named.
    const outside = xs.filter((x) => { const n = num(x.value_text); const l = num(x.lower_text); const h = num(x.upper_text); return n !== null && ((l !== null && n < l) || (h !== null && n > h)); });
    if (outside.length) {
      out.push(`${batch}: ${item} at step ${step}: ${outside.length} of ${xs.length} reading(s) outside the limit: ${outside.map((x) => `${x.value_text} ${unit}`.trim()).join(', ')}${limits}.`);
      continue;
    }
    if (xs.some((x) => x.failed)) {
      out.push(`${batch}: ${item} at step ${step}: the check failed (${xs.filter((x) => x.failed).length} of ${xs.length} reading(s) marked failed${xs[0]!.limit_tier ? `, ${xs[0]!.limit_tier.toLowerCase()} limit` : ''})${limits}.`);
      continue;
    }
    // Inside the limits but close to one (within 10 % of the range): worth a look.
    if (lo !== null && hi !== null && hi > lo) {
      const edge = xs.filter((x) => { const n = num(x.value_text); return n !== null && (n - lo < 0.1 * (hi - lo) || hi - n < 0.1 * (hi - lo)); });
      if (edge.length) out.push(`${batch}: ${item} at step ${step}: ${edge.map((x) => `${x.value_text} ${unit}`.trim()).join(', ')} inside the limits but close to one${limits}.`);
    }
  }
  // In-process checks (S18): individual readings against their own limits, the aggregate (e.g. mean) against
  // its action and alert limits, and Batchwright's own result.
  const checks = new Map<string, BatchwrightData['ipc']>();
  for (const x of d.ipc) checks.set(`${x.batch_number}|${x.step}|${x.item}`, [...(checks.get(`${x.batch_number}|${x.step}|${x.item}`) ?? []), x]);
  for (const [k, xs] of checks) {
    const [batch, step, item] = k.split('|');
    const first = xs[0]!;
    const unit = first.unit ?? '';
    const where = `${first.step_title ?? step}${first.instrument_code ? ` on ${first.instrument_code}` : ''}`;
    const singles = xs.filter((x) => x.aggregate === null);
    const outside = singles.filter((x) => { const n = num(x.value_text); const l = num(x.lower_text); const h = num(x.upper_text); return n !== null && ((l !== null && n < l) || (h !== null && n > h)); });
    const agg = xs.filter((x) => x.aggregate !== null);
    const failed = xs.some((x) => /fail/i.test(x.result ?? ''));
    if (!outside.length && !failed && !agg.some((a) => { const n = num(a.value_text); const al = num(a.alert_lower_text); const ah = num(a.alert_upper_text); return n !== null && ((al !== null && n < al) || (ah !== null && n > ah)); })) continue;
    const parts: string[] = [];
    if (outside.length) parts.push(`${outside.length} of ${singles.length} reading(s) outside ${num(first.lower_text) ?? '–'}–${num(first.upper_text) ?? '–'} ${unit}: ${outside.map((x) => x.value_text).join(', ')} ${unit}`.trim());
    for (const a of agg) {
      const n = num(a.value_text); const lo = num(a.lower_text); const al = num(a.alert_lower_text); const hi = num(a.upper_text); const ah = num(a.alert_upper_text);
      const note = n === null ? '' : (lo !== null && n < lo) || (hi !== null && n > hi) ? ' (outside the action limit)' : (al !== null && n < al) || (ah !== null && n > ah) ? ' (below or above the alert limit)' : '';
      parts.push(`${a.aggregate} ${a.value_text} ${unit}${note}`.trim());
    }
    out.push(`${batch}: ${item} check at ${where}${failed ? ' FAILED' : ''}: ${parts.join('; ')}.`);
  }
  // Process actuals (S18) outside or close to their limits.
  for (const a of d.actuals) {
    const n = num(a.value_text); const lo = num(a.lower_text); const hi = num(a.upper_text);
    const limits = lo !== null || hi !== null ? ` (limits ${lo ?? '–'} to ${hi ?? '–'} ${a.unit ?? ''})` : '';
    if (a.within_limits === false || (n !== null && ((lo !== null && n < lo) || (hi !== null && n > hi)))) out.push(`${a.batch_number}: ${a.tag} at step ${a.step}: ${a.value_text} ${a.unit ?? ''} outside the limit${limits}.`);
    else if (n !== null && lo !== null && hi !== null && hi > lo && (n - lo < 0.1 * (hi - lo) || hi - n < 0.1 * (hi - lo))) out.push(`${a.batch_number}: ${a.tag} at step ${a.step}: ${a.value_text} ${a.unit ?? ''} inside the limits but close to one${limits}.`);
  }
  // Exception details (S18) replace the bare exception list when present.
  for (const e of d.exceptionDetails.filter((x) => x.exception_type !== 'MANUAL_ENTRY_FALLBACK' && x.category !== 'MANUAL_ENTRY')) {
    out.push(`${e.batch_number}: exception ${e.exception_id} (${e.exception_type.toLowerCase().replace(/_/g, ' ')}${e.severity ? `, ${e.severity.toLowerCase()}` : ''})${e.step_title || e.step ? ` at ${e.step_title ?? e.step}` : ''}${e.description ? `: ${e.description}` : ''}; ${e.disposition ? `disposition: ${e.disposition}` : `status ${(e.status ?? 'open').toLowerCase()}`}.`);
  }
  const detailed = new Set(d.exceptionDetails.map((x) => x.exception_id));
  for (const e of d.exceptions.filter((x) => x.exception_type !== 'MANUAL_ENTRY_FALLBACK' && x.category !== 'MANUAL_ENTRY' && !detailed.has(x.exception_id))) out.push(`${e.batch_number}: exception ${e.exception_id} (${e.exception_type.toLowerCase().replace(/_/g, ' ')}${e.severity ? `, ${e.severity.toLowerCase()}` : ''}).`);
  const manual = d.exceptions.filter((x) => x.exception_type === 'MANUAL_ENTRY_FALLBACK' || x.category === 'MANUAL_ENTRY').length;
  if (manual) out.push(`${manual} value(s) were entered by hand instead of from the instrument (manual-entry exceptions).`);
  for (const a of d.alarms) out.push(`Alarm ${a.alarm_code}${a.gmp_critical ? ' (GMP-critical)' : ''} on ${a.subject_code ?? a.subject_kind ?? '?'}${a.acked_at ? '' : ', not acknowledged'}.`);
  if (d.equipmentUsed.length) out.push(`Equipment used by the batch: ${d.equipmentUsed.join(', ')} (looked up in the Logbook too).`);
  return out;
}
