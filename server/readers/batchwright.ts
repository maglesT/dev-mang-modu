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
    // A view counts only if this login may read it (a view created before its grant is skipped, not a failure).
    // CASE fixes the order: no schema rights means no lookups at all.
    const present = new Set((await tx<{ name: string }[]>`
      select n as name from unnest(${OPTIONAL}::text[]) n
      where case when not has_schema_privilege(${src.schema}, 'USAGE') then false
                 when to_regclass(format('%I.%I', ${src.schema}::text, n)) is null then false
                 else has_table_privilege(format('%I.%I', ${src.schema}::text, n), 'SELECT') end`).map((r) => r.name));
    const has = (name: string) => present.has(name);
    const references = has('batch_reference_v1') ? await tx<BatchwrightData['references']>`
      select batch_number, kind, code, version, title from ${v('batch_reference_v1')} where ${b} = any(${q.batchesNorm}) order by batch_number, kind, code limit 200` : [];
    // The four S16 views also come as functions taking batch numbers (report.<view>_for(text[])): the same columns,
    // milliseconds per batch instead of a scan of every batch. Used when this login may run them, else the view.
    const exact = batches.map((x) => x.batch_number);
    const fns = new Set((await tx<{ name: string }[]>`
      select n as name from unnest(${OPTIONAL}::text[]) n
      where case when not has_schema_privilege(${src.schema}, 'USAGE') then false
                 when to_regprocedure(format('%I.%I(text[])', ${src.schema}::text, n || '_for')) is null then false
                 else has_function_privilege(format('%I.%I(text[])', ${src.schema}::text, n || '_for'), 'EXECUTE') end`).map((r) => r.name));
    const from = (name: string) => (fns.has(name) ? tx`${tx(src.schema)}.${tx(`${name}_for`)}(${exact}::text[])` : tx`${v(name)}`);
    const read = (name: string) => has(name) || fns.has(name);
    // cols and order are constants of this file (never user input).
    const rowsOf = async <T,>(name: string, cols: string, order: string, limit: number): Promise<T[]> =>
      read(name) && exact.length
        ? ([...await tx`select ${tx.unsafe(cols)} from ${from(name)} x where ${tx.unsafe(norm('x.batch_number'))} = any(${q.batchesNorm}) order by ${tx.unsafe(order)} limit ${limit}`] as T[])
        : [];
    const equipmentUse = await rowsOf<BatchwrightData['equipmentUse'][number]>('equipment_use_v1',
      'batch_number, equipment_code, equipment_type, room_code, step, started_at, ended_at', 'batch_number, started_at nulls last', 1000);
    const ipc = await rowsOf<BatchwrightData['ipc'][number]>('ipc_result_v1',
      'batch_number, step, step_title, check_kind, item, instrument_code, reading, value_text, unit, lower_text, upper_text, aggregate, alert_lower_text, alert_upper_text, result, recorded_at',
      'batch_number, recorded_at nulls last, step, item, aggregate nulls first, reading', 3000);
    const actuals = await rowsOf<BatchwrightData['actuals'][number]>('process_actual_v1',
      'batch_number, step, tag, value_text, unit, lower_text, upper_text, within_limits, recorded_at', 'batch_number, recorded_at nulls last, step, tag', 3000);
    const exceptionDetails = await rowsOf<BatchwrightData['exceptionDetails'][number]>('exception_detail_v1',
      'batch_number, exception_id, exception_type, category, severity, step, step_title, description, status, disposition, disposed_by, disposed_at, raised_at', 'raised_at', 500);
    const viewsRead = ['batch_fact_v1', 'step_use_v1', 'cpp_value_v1', 'exception_v1', 'alarm_v1',
      ...OPTIONAL.filter((n) => fns.has(n) ? false : has(n)), ...OPTIONAL.filter((n) => fns.has(n)).map((n) => `${n}_for`)];
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
  // The newer views describe in-process checks and actuals in full; the same values are not reported twice.
  const ipcBatches = new Set(d.ipc.map((x) => x.batch_number));
  const actualTags = new Set(d.actuals.map((x) => `${x.batch_number}|${x.tag}`));
  for (const x of d.values.filter((x) => x.kind === 'PARAMETER' && !(x.role === 'IPC' && ipcBatches.has(x.batch_number)) && !actualTags.has(`${x.batch_number}|${x.item}`))) {
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
  const side = (n: number, lo: number | null, hi: number | null, what: string) =>
    lo !== null && n < lo ? `below the ${what} limit ${lo}` : hi !== null && n > hi ? `above the ${what} limit ${hi}` : null;
  for (const [k, xs] of checks) {
    const [batch, step, item] = k.split('|');
    const singles = xs.filter((x) => x.aggregate === null);
    const ref = singles[0] ?? xs[0]!;
    const unit = ref.unit ?? '';
    const where = `${ref.step_title ?? step}${ref.instrument_code ? ` on ${ref.instrument_code}` : ''}`;
    // Each reading against its own limits (a retest may have its own).
    const outside = singles.filter((x) => { const n = num(x.value_text); return n !== null && side(n, num(x.lower_text), num(x.upper_text), 'action') !== null; });
    const failed = xs.some((x) => /fail/i.test(x.result ?? ''));
    const aggNotes = xs.filter((x) => x.aggregate !== null && num(x.value_text) !== null).map((a) => {
      const n = num(a.value_text)!;
      const note = side(n, num(a.lower_text), num(a.upper_text), 'action') ?? side(n, num(a.alert_lower_text), num(a.alert_upper_text), 'alert');
      return { text: `${a.aggregate} ${a.value_text} ${unit}${note ? ` (${note})` : ''}`.trim(), flagged: note !== null };
    });
    if (!outside.length && !failed && !aggNotes.some((x) => x.flagged)) continue;
    const parts: string[] = [];
    if (outside.length) {
      const lims = [...new Set(outside.map((x) => `${num(x.lower_text) ?? '–'}–${num(x.upper_text) ?? '–'} ${unit}`.trim()))].join(' / ');
      parts.push(`${outside.length} of ${singles.length} reading(s) outside ${lims}: ${outside.map((x) => x.value_text).join(', ')} ${unit}`.trim());
    }
    parts.push(...aggNotes.map((x) => x.text));
    out.push(`${batch}: ${item} check at ${where}${failed ? ' FAILED' : ''}${parts.length ? `: ${parts.join('; ')}` : ' (Batchwright recorded the result only)'}.`);
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
  const manual = new Set([...d.exceptions, ...d.exceptionDetails].filter((x) => x.exception_type === 'MANUAL_ENTRY_FALLBACK' || x.category === 'MANUAL_ENTRY').map((x) => `${x.batch_number}|${x.exception_id}`)).size;
  if (manual) out.push(`${manual} value(s) were entered by hand instead of from the instrument (manual-entry exceptions).`);
  for (const a of d.alarms) out.push(`Alarm ${a.alarm_code}${a.gmp_critical ? ' (GMP-critical)' : ''} on ${a.subject_code ?? a.subject_kind ?? '?'}${a.acked_at ? '' : ', not acknowledged'}.`);
  if (d.equipmentUsed.length) out.push(`Equipment used by the batch: ${d.equipmentUsed.join(', ')} (looked up in the Logbook too).`);
  return out;
}
