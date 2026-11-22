// D-59: the one list of TrueBatch products Deviations reads. A new product is one more line here: its link
// (<KEY>_DATABASE_URL, written by the platform's apply only while the link is on), "Fetch related data", the report
// form's batch list, the check of a picked batch, the automatic filing of its deviation notes (reporter <key>.auto, area
// "<name> (automatic)", source_ref <key>:note:<note_id>) and the names on screen and in the PDF all follow from it.
// A bulk product publishes its batches as batch_fact_v1, a packing product as packing_batch_v1; all publish
// equipment_use_v1 and deviation_note_v1 with the same columns. TrueBatch API is one product (packing is its last
// stage), so it publishes batch_fact_v1. No imports: the web pages use this list too.
export const TRUEBATCH_PRODUCTS = [
  { key: 'truebatch', name: 'TrueBatch Tablets', packing: false },
  { key: 'truebatch_injectables', name: 'TrueBatch Injectables', packing: false },
  { key: 'truebatch_packing', name: 'TrueBatch Tablets Packing', packing: true },
  { key: 'truebatch_injectables_packing', name: 'TrueBatch Injectables Packing', packing: true },
  { key: 'truebatch_capsules', name: 'TrueBatch Capsules', packing: false },
  { key: 'truebatch_capsules_packing', name: 'TrueBatch Capsules Packing', packing: true },
  { key: 'truebatch_liquids', name: 'TrueBatch Oral Liquids', packing: false },
  { key: 'truebatch_liquids_packing', name: 'TrueBatch Oral Liquids Packing', packing: true },
  { key: 'truebatch_api', name: 'TrueBatch API', packing: false },
] as const;

type Entry = (typeof TRUEBATCH_PRODUCTS)[number];
export type BatchProduct = Entry['key'];
export const BATCH_PRODUCTS = TRUEBATCH_PRODUCTS.map((p) => p.key) as readonly BatchProduct[] as readonly [BatchProduct, ...BatchProduct[]];
export const PRODUCT_NAME = Object.fromEntries(TRUEBATCH_PRODUCTS.map((p) => [p.key, p.name])) as Record<BatchProduct, string>;
const PACKING = new Set<string>(TRUEBATCH_PRODUCTS.filter((p) => p.packing).map((p) => p.key));
export const isPacking = (p: BatchProduct) => PACKING.has(p);

/** The platform's setting for a product's link, e.g. TRUEBATCH_CAPSULES_DATABASE_URL. */
export type LinkSetting = `${Uppercase<BatchProduct>}_DATABASE_URL`;
export const linkSetting = (p: BatchProduct) => `${p.toUpperCase()}_DATABASE_URL` as LinkSetting;
