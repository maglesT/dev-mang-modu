import { normaliseBatch } from '../deviations.js';
import type { Sources } from './fetch.js';
import { BATCH_PRODUCTS, PRODUCT_NAME, hasBatches, listBatches, type BatchPick } from './truebatch.js';

// D-57: the report form's batch is picked from the batches of the linked TrueBatch products (batch · product · status);
// the product comes with the picked batch. A batch not in the list is typed by hand and kept marked so. A product whose
// link is off or down is left out of the list with a note; the other products are still listed.
export async function batchPicks(sources: Sources, log: (msg: string) => void = () => {}): Promise<{ batches: BatchPick[]; notes: string[] }> {
  const linked = BATCH_PRODUCTS.filter((p) => sources[p]);
  const results = await Promise.all(linked.map(async (p) => {
    try { return { batches: await listBatches(sources[p]!, p), note: null }; } catch (e) {
      log(`${PRODUCT_NAME[p]} batch list failed: ${e instanceof Error ? e.message : String(e)}`);
      return { batches: [] as BatchPick[], note: `${PRODUCT_NAME[p]} could not be read: its batches are not in the list (type the batch by hand).` };
    }
  }));
  return { batches: results.flatMap((r) => r.batches), notes: results.flatMap((r) => (r.note ? [r.note] : [])) };
}

/**
 * The check, once, on saving: a batch marked as picked from a product is in that product (read now). A row picked
 * before and saved unchanged (a correction of the report) is not read again. Problems in plain words; none = all good.
 */
// D-60: a lot pulled with a LIMS OOS (`from` 'lims') is not read here: it comes with the OOS, checked by the OOS pick.
export async function confirmPicks(sources: Sources, rows: { batch: string; from?: string }[], before: { batch: string; from?: string }[] = []): Promise<string[]> {
  const kept = new Set(before.filter((r) => r.from).map((r) => `${r.from}|${normaliseBatch(r.batch)}`));
  const todo = rows.filter((r) => r.from && !kept.has(`${r.from}|${normaliseBatch(r.batch)}`));
  const problems: string[] = [];
  for (const p of BATCH_PRODUCTS) {
    const mine = todo.filter((r) => r.from === p);
    if (!mine.length) continue;
    let found: Set<string> | null = null;
    try { found = sources[p] ? await hasBatches(sources[p]!, p, mine.map((r) => normaliseBatch(r.batch))) : null; } catch { found = null; }
    for (const r of mine) {
      if (!found) problems.push(`Batch ${r.batch}: ${PRODUCT_NAME[p]} could not be read now. Pick it again later, or type it by hand.`);
      else if (!found.has(normaliseBatch(r.batch))) problems.push(`Batch ${r.batch} is not in ${PRODUCT_NAME[p]}. Pick it from the list, or type it by hand.`);
    }
  }
  return problems;
}
