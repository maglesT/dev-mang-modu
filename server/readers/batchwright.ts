import type { Query, Source } from './logbook.js';

// S17 (D-37, DV-23): reads Batchwright's read-only report views as the role ebmr_report (contract:
// docs/07-data-contracts.md). Never Batchwright's deviation module, never a write. Text comparisons only.
export const BATCHWRIGHT_VIEWS = ['batch_fact_v1', 'step_use_v1', 'cpp_value_v1', 'exception_v1', 'alarm_v1', 'batch_reference_v1'];

export interface BatchwrightData {
  batches: { batch_number: string; product_code: string | null; strength: string | null; family_code: string | null; status: string; issued_at: string | null; completed_at: string | null; released: boolean }[];
  steps: { batch_number: string; step: string; step_id: string | null; equipment_code: string | null; equipment_type: string | null; room_code: string | null;
    started_at: string | null; ended_at: string | null; material_lots: { lot: string; supplier: string | null }[] }[];
  values: { batch_number: string; kind: string; item: string; step: string; attempt: number | null; reading: number | null; role: string | null; value_text: string | null; unit: string | null;
    lower_text: string | null; upper_text: string | null; target_text: string | null; limit_tier: string | null; failed: boolean; recorded_at: string | null }[];
  exceptions: { batch_number: string; exception_id: string; exception_type: string; category: string | null; severity: string | null; raised_at: string | null }[];
  alarms: { alarm_code: string; source: string | null; gmp_critical: boolean; subject_kind: string | null; subject_code: string | null; raised_at: string | null; acked_at: string | null; batch_numbers: string[] }[];
  references: { batch_number: string; kind: string; code: string; version: string | null; title: string | null }[];
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
    return { batches: [], steps: [], values: [], exceptions: [], alarms: [], references: [], equipmentUsed: [], readAt: now!.at, dataAsOf: null };
  }
  return s.begin('read only', async (tx) => {
    const b = tx.unsafe(norm('batch_number'));
    const batches = await tx<BatchwrightData['batches']>`
      select batch_number, product_code, strength, family_code, status, issued_at, completed_at, released
      from ${v('batch_fact_v1')} where ${b} = any(${q.batchesNorm}) order by issued_at`;
    const steps = await tx<BatchwrightData['steps']>`
      select batch_number, step, step_id, nullif(equipment_code, '') as equipment_code, nullif(equipment_type, '') as equipment_type,
        nullif(room_code, '') as room_code, started_at, ended_at, coalesce(material_lots, '[]'::jsonb) as material_lots
      from ${v('step_use_v1')} where ${b} = any(${q.batchesNorm}) order by batch_number, started_at nulls last`;
    const values = await tx<BatchwrightData['values']>`
      select batch_number, kind, item, step, attempt, reading, role, value_text, unit, lower_text, upper_text, target_text, limit_tier, failed, recorded_at
      from ${v('cpp_value_v1')} where ${b} = any(${q.batchesNorm}) order by batch_number, recorded_at nulls last, step, item, reading`;
    const exceptions = await tx<BatchwrightData['exceptions']>`
      select batch_number, exception_id, exception_type, category, severity, raised_at
      from ${v('exception_v1')} where ${b} = any(${q.batchesNorm}) order by raised_at`;
    const alarms = await tx<BatchwrightData['alarms']>`
      select alarm_code, source, gmp_critical, subject_kind, subject_code, raised_at, acked_at, coalesce(batch_numbers, '{}') as batch_numbers
      from ${v('alarm_v1')} a
      where exists (select 1 from unnest(a.batch_numbers) n where ${tx.unsafe(norm('n'))} = any(${q.batchesNorm}))
      order by raised_at`;
    const references = await tx<BatchwrightData['references']>`
      select batch_number, kind, code, version, title from ${v('batch_reference_v1')} where ${b} = any(${q.batchesNorm}) order by batch_number, kind, code`;
    const [asOf] = await tx<{ at: string | null }[]>`select greatest(
      (select max(data_as_of) from ${v('batch_fact_v1')} where ${b} = any(${q.batchesNorm})),
      (select max(data_as_of) from ${v('cpp_value_v1')} where ${b} = any(${q.batchesNorm}))) as at`;
    const [now] = await tx<{ at: string }[]>`select now() as at`;
    const equipmentUsed = [...new Set(steps.map((x) => x.equipment_code).filter((x): x is string => !!x))];
    return { batches, steps, values, exceptions, alarms, references, equipmentUsed, readAt: now!.at, dataAsOf: asOf?.at ?? null };
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
    // Batchwright marks the readings of a failed check; the values actually outside the limits are named.
    const outside = xs.filter((x) => { const n = num(x.value_text); return n !== null && ((lo !== null && n < lo) || (hi !== null && n > hi)); });
    if (xs.some((x) => x.failed) || outside.length) {
      const named = outside.length ? outside : xs.filter((x) => x.failed);
      out.push(`${batch}: ${item} at step ${step}: check failed; ${named.length} of ${xs.length} reading(s) outside the limit: ${named.map((x) => `${x.value_text} ${unit}`.trim()).join(', ')}${limits}.`);
      continue;
    }
    // Inside the limits but close to one (within 10 % of the range): worth a look.
    if (lo !== null && hi !== null && hi > lo) {
      const edge = xs.filter((x) => { const n = num(x.value_text); return n !== null && (n - lo < 0.1 * (hi - lo) || hi - n < 0.1 * (hi - lo)); });
      if (edge.length) out.push(`${batch}: ${item} at step ${step}: ${edge.map((x) => `${x.value_text} ${unit}`.trim()).join(', ')} inside the limits but close to one${limits}.`);
    }
  }
  for (const e of d.exceptions.filter((x) => x.exception_type !== 'MANUAL_ENTRY_FALLBACK')) out.push(`${e.batch_number}: exception ${e.exception_id} (${e.exception_type.toLowerCase().replace(/_/g, ' ')}${e.severity ? `, ${e.severity.toLowerCase()}` : ''}).`);
  const manual = d.exceptions.filter((x) => x.exception_type === 'MANUAL_ENTRY_FALLBACK').length;
  if (manual) out.push(`${manual} value(s) were entered by hand instead of from the instrument (manual-entry exceptions).`);
  for (const a of d.alarms) out.push(`Alarm ${a.alarm_code}${a.gmp_critical ? ' (GMP-critical)' : ''} on ${a.subject_code ?? a.subject_kind ?? '?'}${a.acked_at ? '' : ', not acknowledged'}.`);
  if (d.equipmentUsed.length) out.push(`Equipment used by the batch: ${d.equipmentUsed.join(', ')} (looked up in the Logbook too).`);
  return out;
}
