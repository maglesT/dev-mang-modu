import type { Query, Source } from './logbook.js';
import type { Sql, Tx } from '../db.js';

// S17 (D-37, DV-23), D-51: reads TrueBatch's read-only report views (contract: docs/07-data-contracts.md). Never a write.
// Text comparisons only. equipment_use_v1 is optional: read when present and readable. D-56: Batchwright is retired; its
// other views are no longer read (copies fetched before stay readable).
// D-57: all four TrueBatch products are read, each through its own link: Tablets and Injectables publish the batch fact
// as batch_fact_v1, the two Packing products as packing_batch_v1. The fact views differ in columns, so each row is read
// as JSON (to_jsonb) and a column a product does not publish reads as null.
export const BATCH_PRODUCTS = ['truebatch', 'truebatch_injectables', 'truebatch_packing', 'truebatch_injectables_packing'] as const;
export type BatchProduct = (typeof BATCH_PRODUCTS)[number];
export const PRODUCT_NAME: Record<BatchProduct, string> = {
  truebatch: 'TrueBatch', truebatch_injectables: 'TrueBatch Injectables',
  truebatch_packing: 'TrueBatch Packing', truebatch_injectables_packing: 'TrueBatch Injectables Packing',
};
export const factView = (p: BatchProduct) => (p.endsWith('_packing') ? 'packing_batch_v1' : 'batch_fact_v1');
export const viewsOf = (p: BatchProduct) => [factView(p), 'equipment_use_v1'];
export const TRUEBATCH_VIEWS = viewsOf('truebatch');

export interface TrueBatchData {
  batches: { batch_number: string; product_code: string | null; strength: string | null; family_code: string | null; status: string; issued_at: string | null; completed_at: string | null; released: boolean;
    // Packing only (packing_batch_v1): the batch printed on the packs and the bulk product packed.
    coded_batch_number: string | null; bulk_product_code: string | null }[];
  equipmentUse: { batch_number: string; equipment_code: string; equipment_type: string | null; room_code: string | null; step: string | null; started_at: string | null; ended_at: string | null }[];
  viewsRead: string[];
  equipmentUsed: string[];
  readAt: string;
  dataAsOf: string | null;
}

/**
 * Whether a view is there and this login may read it (to_regclass needs no rights on the view itself; a view created
 * before its grant is skipped, not a failure). CASE fixes the order: no schema rights, no lookups.
 */
export async function canRead(tx: Sql | Tx, schema: string, view: string): Promise<boolean> {
  const [r] = await tx<{ ok: boolean }[]>`
    select case when not has_schema_privilege(${schema}, 'USAGE') then false
                when to_regclass(format('%I.%I', ${schema}::text, ${view}::text)) is null then false
                else has_table_privilege(format('%I.%I', ${schema}::text, ${view}::text), 'SELECT') end as ok`;
  return !!r?.ok;
}

const norm = (col: string) => `lower(regexp_replace(coalesce(${col}, ''), '[\\s\\-/._]+', '', 'g'))`;

export async function readTrueBatch(src: Source, q: Query, product: BatchProduct = 'truebatch'): Promise<TrueBatchData> {
  const s = src.sql;
  const v = (name: string) => s(`${src.schema}.${name}`);
  const fact = factView(product);
  if (!q.batchesNorm.length) {
    const [now] = await s<{ at: string }[]>`select now() as at`;
    return { batches: [], equipmentUse: [], viewsRead: [], equipmentUsed: [], readAt: now!.at, dataAsOf: null };
  }
  return s.begin('read only', async (tx) => {
    await tx`set local statement_timeout = '15s'`;
    const b = tx.unsafe(norm('batch_number'));
    const batches = await tx<TrueBatchData['batches']>`
      select x->>'batch_number' as batch_number, x->>'product_code' as product_code, x->>'strength' as strength, x->>'family_code' as family_code,
             x->>'status' as status, (x->>'issued_at')::timestamptz as issued_at, (x->>'completed_at')::timestamptz as completed_at,
             coalesce((x->>'released')::boolean, false) as released, x->>'coded_batch_number' as coded_batch_number, x->>'bulk_product_code' as bulk_product_code
      from (select to_jsonb(f) as x from ${v(fact)} f where ${b} = any(${q.batchesNorm})) r order by (x->>'issued_at')::timestamptz`;
    const eq = { ok: await canRead(tx, src.schema, 'equipment_use_v1') };
    const equipmentUse = eq.ok && batches.length ? await tx<TrueBatchData['equipmentUse']>`
      select batch_number, equipment_code, equipment_type, room_code, step, started_at, ended_at
      from ${v('equipment_use_v1')} where ${b} = any(${q.batchesNorm}) order by batch_number, started_at nulls last limit 1000` : [];
    const viewsRead = [fact, ...(eq.ok ? ['equipment_use_v1'] : [])];
    const [asOf] = await tx<{ at: string | null }[]>`select max(data_as_of) as at from ${v(fact)} where ${b} = any(${q.batchesNorm})`;
    const [now] = await tx<{ at: string }[]>`select now() as at`;
    const equipmentUsed = [...new Set(equipmentUse.map((x) => x.equipment_code).filter((x): x is string => !!x))];
    return { batches, equipmentUse, viewsRead, equipmentUsed, readAt: now!.at, dataAsOf: asOf?.at ?? null };
  });
}

// Plain-words findings for the investigator (advice; the copy is the evidence).
export function trueBatchFindings(d: TrueBatchData, product: BatchProduct = 'truebatch'): string[] {
  const out: string[] = [];
  if (!d.batches.length) out.push(`No batch with this number was found in ${PRODUCT_NAME[product]}.`);
  for (const b of d.batches) {
    out.push(`${b.batch_number} (${b.product_code ?? 'product ?'}): status ${String(b.status ?? '?').toLowerCase().replace(/_/g, ' ')}${b.released ? ', released' : ', not released'}`
      + `${b.coded_batch_number ? `; batch printed on the packs ${b.coded_batch_number}${b.bulk_product_code ? ` (${b.bulk_product_code})` : ''}` : ''}.`);
  }
  if (d.equipmentUsed.length) out.push(`Equipment used by the batch: ${d.equipmentUsed.join(', ')} (looked up in the Logbook too).`);
  return out;
}

// D-57: the batches a reporter picks from on the report form (newest first), and the check that a picked batch is
// really in that product. Read-only, as the fetch.
export interface BatchPick { batch: string; product: string | null; productName: string | null; status: string | null; from: BatchProduct }
export const PICK_LIMIT = 300;

export async function listBatches(src: Source, product: BatchProduct): Promise<BatchPick[]> {
  return src.sql.begin('read only', async (tx) => {
    await tx`set local statement_timeout = '10s'`;
    const rows = await tx<Omit<BatchPick, 'from'>[]>`
      select x->>'batch_number' as batch, x->>'product_code' as product, x->>'product_name' as "productName", x->>'status' as status
      from (select to_jsonb(f) as x from ${tx(`${src.schema}.${factView(product)}`)} f) r
      where coalesce(x->>'batch_number', '') <> '' order by (x->>'issued_at')::timestamptz desc nulls last limit ${PICK_LIMIT}`;
    return rows.map((r) => ({ ...r, from: product }));
  });
}

export async function hasBatches(src: Source, product: BatchProduct, batchesNorm: string[]): Promise<Set<string>> {
  return src.sql.begin('read only', async (tx) => {
    await tx`set local statement_timeout = '10s'`;
    const b = tx.unsafe(norm('batch_number'));
    const rows = await tx<{ n: string }[]>`select distinct ${b} as n from ${tx(`${src.schema}.${factView(product)}`)} where ${b} = any(${batchesNorm})`;
    return new Set(rows.map((r) => r.n));
  });
}
