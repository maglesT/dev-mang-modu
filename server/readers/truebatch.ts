import type { Query, Source } from './logbook.js';

// S17 (D-37, DV-23), D-51: reads TrueBatch's read-only report views batch_fact_v1 and equipment_use_v1 (contract:
// docs/07-data-contracts.md). Never a write. Text comparisons only. equipment_use_v1 is optional: read when present
// and readable. D-56: Batchwright is retired; its other views are no longer read (copies fetched before stay readable).
export const TRUEBATCH_VIEWS = ['batch_fact_v1', 'equipment_use_v1'];

export interface TrueBatchData {
  batches: { batch_number: string; product_code: string | null; strength: string | null; family_code: string | null; status: string; issued_at: string | null; completed_at: string | null; released: boolean }[];
  equipmentUse: { batch_number: string; equipment_code: string; equipment_type: string | null; room_code: string | null; step: string | null; started_at: string | null; ended_at: string | null }[];
  viewsRead: string[];
  equipmentUsed: string[];
  readAt: string;
  dataAsOf: string | null;
}

const norm = (col: string) => `lower(regexp_replace(coalesce(${col}, ''), '[\\s\\-/._]+', '', 'g'))`;

export async function readTrueBatch(src: Source, q: Query): Promise<TrueBatchData> {
  const s = src.sql;
  const v = (name: string) => s(`${src.schema}.${name}`);
  if (!q.batchesNorm.length) {
    const [now] = await s<{ at: string }[]>`select now() as at`;
    return { batches: [], equipmentUse: [], viewsRead: [], equipmentUsed: [], readAt: now!.at, dataAsOf: null };
  }
  return s.begin('read only', async (tx) => {
    await tx`set local statement_timeout = '15s'`;
    const b = tx.unsafe(norm('batch_number'));
    const batches = await tx<TrueBatchData['batches']>`
      select batch_number, product_code, strength, family_code, status, issued_at, completed_at, released
      from ${v('batch_fact_v1')} where ${b} = any(${q.batchesNorm}) order by issued_at`;
    // Whether equipment_use_v1 is there and this login may read it (to_regclass needs no rights on the view itself;
    // a view created before its grant is skipped, not a failure). CASE fixes the order: no schema rights, no lookups.
    const [eq] = await tx<{ ok: boolean }[]>`
      select case when not has_schema_privilege(${src.schema}, 'USAGE') then false
                  when to_regclass(format('%I.%I', ${src.schema}::text, 'equipment_use_v1')) is null then false
                  else has_table_privilege(format('%I.%I', ${src.schema}::text, 'equipment_use_v1'), 'SELECT') end as ok`;
    const equipmentUse = eq?.ok && batches.length ? await tx<TrueBatchData['equipmentUse']>`
      select batch_number, equipment_code, equipment_type, room_code, step, started_at, ended_at
      from ${v('equipment_use_v1')} where ${b} = any(${q.batchesNorm}) order by batch_number, started_at nulls last limit 1000` : [];
    const viewsRead = ['batch_fact_v1', ...(eq?.ok ? ['equipment_use_v1'] : [])];
    const [asOf] = await tx<{ at: string | null }[]>`select max(data_as_of) as at from ${v('batch_fact_v1')} where ${b} = any(${q.batchesNorm})`;
    const [now] = await tx<{ at: string }[]>`select now() as at`;
    const equipmentUsed = [...new Set(equipmentUse.map((x) => x.equipment_code).filter((x): x is string => !!x))];
    return { batches, equipmentUse, viewsRead, equipmentUsed, readAt: now!.at, dataAsOf: asOf?.at ?? null };
  });
}

// Plain-words findings for the investigator (advice; the copy is the evidence).
export function trueBatchFindings(d: TrueBatchData): string[] {
  const out: string[] = [];
  if (!d.batches.length) out.push('No batch with this number was found in TrueBatch.');
  for (const b of d.batches) out.push(`${b.batch_number} (${b.product_code ?? 'product ?'}): status ${b.status.toLowerCase().replace(/_/g, ' ')}${b.released ? ', released' : ', not released'}.`);
  if (d.equipmentUsed.length) out.push(`Equipment used by the batch: ${d.equipmentUsed.join(', ')} (looked up in the Logbook too).`);
  return out;
}
