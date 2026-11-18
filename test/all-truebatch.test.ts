import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app.js';
import { connect } from '../server/db.js';
import { offMessage } from '../server/readers/fetch.js';
import { APP_ROLE, TEST_DATABASE_URL, TEST_PROOF_KEY, call, fakePeople, fakeSignOn, freshDb, login, seedUser, type TestApp } from './helpers.js';

// D-57: "Fetch related data" and the report form's batch list read all four TrueBatch products, each through its own
// link. Stand-in schemas carry each product's published columns: Tablets and Injectables batch_fact_v1 (Injectables with
// product_name), the two Packing products packing_batch_v1 (Injectables Packing without shippers) and equipment_use_v1.
// D-59: the new products of the one list too: Capsules, Oral Liquids and API (batch_fact_v1) and Capsules Packing and
// Oral Liquids Packing (packing_batch_v1), each with equipment_use_v1, the same columns as Injectables and its Packing.
let t: TestApp;
const c: Record<string, string> = {};
let areaId: number;
const tag = Math.random().toString(36).slice(2, 8);
const S = { tb: `tb57_${tag}`, ti: `ti57_${tag}`, tp: `tp57_${tag}`, tip: `tip57_${tag}`, cut: `cut57_${tag}`,
  tc: `tc59_${tag}`, tcp: `tcp59_${tag}`, tl: `tl59_${tag}`, tlp: `tlp59_${tag}`, ta: `ta59_${tag}` };
// D-59: the new products, each a stand-in of its kind (bulk: batch_fact_v1; packing: packing_batch_v1), one batch each.
const NEW = [
  { p: 'truebatch_capsules', s: S.tc, packing: false, batch: 'TC26001', product: 'FG-CAP-X20', name: 'Example capsules 20 mg', eq: 'CAPSULE-FILLER-01' },
  { p: 'truebatch_capsules_packing', s: S.tcp, packing: true, batch: 'CP26001', product: 'PK-CAP-X20-B10', name: null, eq: 'BLISTER-02' },
  { p: 'truebatch_liquids', s: S.tl, packing: false, batch: 'TL26001', product: 'FG-SYR-X5', name: 'Example syrup 5 mg/5 mL', eq: 'MIXER-01' },
  { p: 'truebatch_liquids_packing', s: S.tlp, packing: true, batch: 'LP26001', product: 'PK-SYR-X5-100', name: null, eq: 'BOTTLE-FILLER-01' },
  { p: 'truebatch_api', s: S.ta, packing: false, batch: 'TA26001', product: 'API-X-01', name: 'Example active substance', eq: 'REACTOR-01' },
] as const;
const event = new Date(Date.now() - 2 * 3_600_000);
const at = (h: number) => new Date(event.getTime() + h * 3_600_000).toISOString();
let reader: ReturnType<typeof connect>;

const EQ = `(batch_number text, equipment_code text, equipment_type text, room_code text, step text, started_at timestamptz, ended_at timestamptz,
  read_at timestamptz default now(), data_as_of timestamptz default now(), step_name text)`;
async function standIns(o: TestApp['owner']) {
  await o.unsafe(`
    create schema ${S.tb}; create schema ${S.ti}; create schema ${S.tp}; create schema ${S.tip}; create schema ${S.cut};
    create table ${S.tb}.batch_fact_v1 (batch_id uuid, batch_number text, product_code text, strength text, family_code text, status text,
      issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz default now());
    create table ${S.tb}.equipment_use_v1 ${EQ};
    insert into ${S.tb}.batch_fact_v1 (batch_number, product_code, status, issued_at, released) values ('TB26001', 'FG-PCM500', 'RELEASED', '${at(-30)}', true);
    create table ${S.ti}.batch_fact_v1 (batch_id uuid, batch_number text, product_code text, strength text, family_code text, status text,
      issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz default now(), product_name text);
    create table ${S.ti}.equipment_use_v1 ${EQ};
    insert into ${S.ti}.batch_fact_v1 (batch_number, product_code, product_name, status, issued_at, released) values
      ('TI26001', 'FG-INJ-X25', 'Example injection 25 mg/mL', 'IN_PRODUCTION', '${at(-20)}', false),
      ('TI26002', 'FG-INJ-X25', 'Example injection 25 mg/mL', 'RELEASED', '${at(-40)}', true);
    insert into ${S.ti}.equipment_use_v1 (batch_number, equipment_code, equipment_type, room_code, step, started_at) values ('TI26001', 'AUTOCLAVE-01', 'EQC-AC', 'STER-1', 'sterilise', '${at(-3)}');
    create table ${S.tp}.packing_batch_v1 (batch_id uuid, batch_number text, coded_batch_number text, product_code text, bulk_product_code text, pack_type text,
      status text, issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz default now(), shippers numeric);
    create table ${S.tp}.equipment_use_v1 ${EQ};
    insert into ${S.tp}.packing_batch_v1 (batch_number, coded_batch_number, product_code, bulk_product_code, status, issued_at, released) values
      ('TP26001', 'TB26001', 'PK-PCM500-B10', 'FG-PCM500', 'IN_PRODUCTION', '${at(-10)}', false);
    insert into ${S.tp}.equipment_use_v1 (batch_number, equipment_code, step, started_at) values ('TP26001', 'BLISTER-01', 'blister', '${at(-2)}');
    create table ${S.tip}.packing_batch_v1 (batch_id uuid, batch_number text, coded_batch_number text, product_code text, bulk_product_code text,
      status text, issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz default now());
    insert into ${S.tip}.packing_batch_v1 (batch_number, product_code, status, issued_at, released) values ('TIP26001', 'FG-INJ-X25-C5', 'RELEASED', '${at(-5)}', true);
    create table ${S.tip}.equipment_use_v1 ${EQ};
  `);
  for (const n of NEW) {
    await o.unsafe(n.packing ? `
      create schema ${n.s};
      create table ${n.s}.packing_batch_v1 (batch_id uuid, batch_number text, coded_batch_number text, product_code text, bulk_product_code text,
        status text, issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz default now());
      insert into ${n.s}.packing_batch_v1 (batch_number, product_code, status, issued_at, released) values ('${n.batch}', '${n.product}', 'IN_PRODUCTION', '${at(-6)}', false);
      create table ${n.s}.equipment_use_v1 ${EQ};
      insert into ${n.s}.equipment_use_v1 (batch_number, equipment_code, step, started_at) values ('${n.batch}', '${n.eq}', 'pack', '${at(-1)}');` : `
      create schema ${n.s};
      create table ${n.s}.batch_fact_v1 (batch_id uuid, batch_number text, product_code text, strength text, family_code text, status text,
        issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz default now(), product_name text);
      insert into ${n.s}.batch_fact_v1 (batch_number, product_code, product_name, status, issued_at, released) values ('${n.batch}', '${n.product}', '${n.name}', 'IN_PRODUCTION', '${at(-6)}', false);
      create table ${n.s}.equipment_use_v1 ${EQ};
      insert into ${n.s}.equipment_use_v1 (batch_number, equipment_code, step, started_at) values ('${n.batch}', '${n.eq}', 'make', '${at(-1)}');`);
  }
}

const sources = (cut: boolean) => ({
  truebatch: { sql: t.owner, schema: S.tb }, truebatch_injectables: { sql: t.owner, schema: S.ti }, truebatch_packing: { sql: t.owner, schema: S.tp },
  // The app's own login on a schema it holds no grant on: what a cut link looks like on the platform (42501).
  truebatch_injectables_packing: cut ? { sql: reader, schema: S.cut } : { sql: t.owner, schema: S.tip },
  ...Object.fromEntries(NEW.map((n) => [n.p, { sql: t.owner, schema: n.s }])),
});

let cutApp: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  const db = await freshDb();
  t = { ...db, app: null as never, close: async () => {} };
  await standIns(db.owner);
  reader = connect(TEST_DATABASE_URL, { role: APP_ROLE }, 1);
  const opts = { sql: db.sql, signOn: fakeSignOn(), people: fakePeople(), proofKey: TEST_PROOF_KEY, webRoot: '/nonexistent' };
  const app = await buildApp({ ...opts, sources: sources(false) });
  cutApp = await buildApp({ ...opts, sources: sources(true) });
  t = { ...db, app, close: async () => { await app.close(); await cutApp.close(); await reader.end(); await db.close(); } };
  for (const [u, roles] of [['adm57', ['admin']], ['us57', ['user']]] as const) {
    await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  c.cut = (await login(cutApp, 'us57')).cookie;
  areaId = (await call(t.app, c.adm57!, 'POST', '/api/areas', { name: 'Sterile' })).json().id;
});
afterAll(async () => {
  await t.owner.unsafe(Object.values(S).map((x) => `drop schema ${x} cascade;`).join(' '));
  await t.close();
});

const body = (products: object[]) => ({
  planned: false, title: 'Autoclave cycle aborted', description: 'Cycle stopped at 110 °C.', areaId, equipment: '', eventAt: event.toISOString(),
  products, immediateAction: 'Load quarantined.', initialImpact: { productQuality: 'unknown', patientSafety: 'unknown', otherBatches: 'no', notes: 'On hold.' },
});
type Fetch = { source: string; status: string; error: string | null; views: string[]; data: { findings?: string[]; batches?: { batch_number: string }[] } };

describe('all four TrueBatch products (D-57)', () => {
  it('D-57: the batch list holds the batches of every linked product (batch, product, status); a cut link is left out with a note', async () => {
    const all = (await call(t.app, c.us57!, 'GET', '/api/batches')).json() as { batches: { batch: string; product: string; productName: string | null; status: string; from: string }[]; notes: string[]; linked: string[] };
    expect(all.batches.map((b) => `${b.from}:${b.batch}`).sort()).toEqual(['truebatch:TB26001', 'truebatch_api:TA26001', 'truebatch_capsules:TC26001',
      'truebatch_capsules_packing:CP26001', 'truebatch_injectables:TI26001', 'truebatch_injectables:TI26002', 'truebatch_injectables_packing:TIP26001',
      'truebatch_liquids:TL26001', 'truebatch_liquids_packing:LP26001', 'truebatch_packing:TP26001']);
    // D-59: every new product lists its batch with its product (and its name where it publishes one).
    for (const n of NEW) expect(all.batches.find((b) => b.from === n.p)).toEqual({ batch: n.batch, product: n.product, productName: n.name, status: 'IN_PRODUCTION', from: n.p });
    expect(all.linked).toEqual(['truebatch', 'truebatch_injectables', 'truebatch_packing', 'truebatch_injectables_packing',
      'truebatch_capsules', 'truebatch_capsules_packing', 'truebatch_liquids', 'truebatch_liquids_packing', 'truebatch_api']);
    expect(all.batches.find((b) => b.batch === 'TI26001')).toMatchObject({ product: 'FG-INJ-X25', productName: 'Example injection 25 mg/mL', status: 'IN_PRODUCTION' });
    // Packing publishes no product_name: read as null, not an error.
    expect(all.batches.find((b) => b.batch === 'TP26001')).toMatchObject({ product: 'PK-PCM500-B10', productName: null });
    expect(all.notes).toEqual([]);
    const cut = (await call(cutApp, c.cut!, 'GET', '/api/batches')).json() as { batches: { from: string }[]; notes: string[] };
    expect(cut.batches.some((b) => b.from === 'truebatch_injectables_packing')).toBe(false);
    expect(cut.batches.length).toBe(4 + NEW.length);
    expect(cut.notes).toEqual(['TrueBatch Injectables Packing could not be read: its batches are not in the list (type the batch by hand).']);
    // Admin (no reporting) gets nothing.
    expect((await call(t.app, c.adm57!, 'GET', '/api/batches')).statusCode).toBe(403);
  });

  it('D-57: a picked batch is saved as picked, a typed one as "typed by hand"; a pick not in its product is refused', async () => {
    const res = await call(t.app, c.us57!, 'POST', '/api/deviations', body([
      { product: 'FG-INJ-X25', batch: 'TI26001', from: 'truebatch_injectables' }, { product: 'Saline 500 mL', batch: 'PAPER-77' }]));
    expect(res.statusCode).toBe(201);
    const d = (await call(t.app, c.us57!, 'GET', `/api/deviations/${res.json().id}`)).json() as { batches: { batch: string; typed: boolean | null }[] };
    expect(d.batches.map((b) => `${b.batch} ${b.typed}`)).toEqual(['TI26001 false', 'PAPER-77 true']);
    const pdf = await call(t.app, c.us57!, 'GET', `/api/deviations/${res.json().id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    // Picked from a product that does not have it: refused in plain words.
    const wrong = await call(t.app, c.us57!, 'POST', '/api/deviations', body([{ product: 'X', batch: 'TI26001', from: 'truebatch_packing' }]));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().problems).toEqual(['Batch TI26001 is not in TrueBatch Packing. Pick it from the list, or type it by hand.']);
    // Picked from a product whose link is cut: refused; typed by hand it is accepted.
    const down = await call(cutApp, c.cut!, 'POST', '/api/deviations', body([{ product: 'FG-INJ-X25-C5', batch: 'TIP26001', from: 'truebatch_injectables_packing' }]));
    expect(down.statusCode).toBe(400);
    expect(down.json().problems[0]).toMatch(/TrueBatch Injectables Packing could not be read now/);
    expect((await call(cutApp, c.cut!, 'POST', '/api/deviations', body([{ product: 'FG-INJ-X25-C5', batch: 'TIP26001' }]))).statusCode).toBe(201);
  });

  it('D-57: a correction keeps a batch picked before without reading it again (its link may be cut by then)', async () => {
    const id = (await call(t.app, c.us57!, 'POST', '/api/deviations', body([{ product: 'FG-INJ-X25-C5', batch: 'TIP26001', from: 'truebatch_injectables_packing' }]))).json().id as number;
    const fixed = await call(cutApp, c.cut!, 'POST', `/api/deviations/${id}/correct`, { kind: 'report', reason: 'Title clarified',
      data: { ...body([{ product: 'FG-INJ-X25-C5', batch: 'TIP26001', from: 'truebatch_injectables_packing' }]), title: 'Autoclave cycle aborted at 110 °C' } });
    expect(fixed.statusCode).toBe(200);
    const d = (await call(t.app, c.us57!, 'GET', `/api/deviations/${id}`)).json() as { batches: { typed: boolean | null }[] };
    expect(d.batches.map((b) => b.typed)).toEqual([false]);
  });

  it('D-57: one fetch reads every linked product for the deviation\'s batches, each as its own copy; a cut link is noted and the others still read', async () => {
    const id = (await call(cutApp, c.cut!, 'POST', '/api/deviations', body([{ product: 'FG-INJ-X25', batch: 'TI 26001' }, { product: 'PK-PCM500-B10', batch: 'TP26001' }]))).json().id as number;
    expect((await call(cutApp, c.cut!, 'POST', `/api/deviations/${id}/fetch`, {})).statusCode).toBe(200);
    const f = (await call(cutApp, c.cut!, 'GET', `/api/deviations/${id}/fetches`)).json() as Fetch[];
    const by = (s: string) => f.find((x) => x.source === s)!;
    expect(f.map((x) => x.source).sort()).toEqual(['logbook', 'truebatch', 'truebatch_api', 'truebatch_capsules', 'truebatch_capsules_packing', 'truebatch_injectables',
      'truebatch_injectables_packing', 'truebatch_liquids', 'truebatch_liquids_packing', 'truebatch_packing']);
    expect(by('truebatch_injectables')).toMatchObject({ status: 'ok', views: ['batch_fact_v1', 'equipment_use_v1'] });
    expect(by('truebatch_injectables').data.findings).toEqual([
      'TI26001 (FG-INJ-X25): status in production, not released.',
      'Equipment used by the batch: AUTOCLAVE-01 (looked up in the Logbook too).',
    ]);
    expect(by('truebatch_packing')).toMatchObject({ status: 'ok', views: ['packing_batch_v1', 'equipment_use_v1'] });
    expect(by('truebatch_packing').data.findings).toEqual([
      'TP26001 (PK-PCM500-B10): status in production, not released; batch printed on the packs TB26001 (FG-PCM500).',
      'Equipment used by the batch: BLISTER-01 (looked up in the Logbook too).',
    ]);
    expect(by('truebatch').data.findings).toEqual(['No batch with this number was found in TrueBatch.']);
    expect(by('truebatch_injectables_packing')).toMatchObject({ status: 'failed', error: offMessage('truebatch_injectables_packing'), views: ['packing_batch_v1', 'equipment_use_v1'] });
    expect(by('logbook').status).toBe('not_configured');
    // The record PDF names every copy.
    expect((await call(cutApp, c.cut!, 'GET', `/api/deviations/${id}/pdf`)).statusCode).toBe(200);
  });
});

describe('the new TrueBatch products (D-59)', () => {
  it('D-59: one fetch reads each new product\'s own fact view and machines; its findings name the product', async () => {
    const id = (await call(t.app, c.us57!, 'POST', '/api/deviations', body(NEW.map((n) => ({ product: n.product, batch: n.batch }))))).json().id as number;
    expect((await call(t.app, c.us57!, 'POST', `/api/deviations/${id}/fetch`, {})).statusCode).toBe(200);
    const f = (await call(t.app, c.us57!, 'GET', `/api/deviations/${id}/fetches`)).json() as Fetch[];
    for (const n of NEW) {
      const x = f.find((y) => y.source === n.p)!;
      expect(x).toMatchObject({ status: 'ok', error: null, views: [n.packing ? 'packing_batch_v1' : 'batch_fact_v1', 'equipment_use_v1'] });
      expect(x.data.findings).toEqual([`${n.batch} (${n.product}): status in production, not released.`, `Equipment used by the batch: ${n.eq} (looked up in the Logbook too).`]);
    }
    // A product with none of these batches says so in its own name.
    expect(f.find((y) => y.source === 'truebatch_injectables')!.data.findings).toEqual(['No batch with this number was found in TrueBatch Injectables.']);
    expect((await call(t.app, c.us57!, 'GET', `/api/deviations/${id}/pdf`)).statusCode).toBe(200);
  });

  it('D-59: a batch picked from a new product is checked there; picked from the wrong one it is refused in that product\'s name', async () => {
    const ok = await call(t.app, c.us57!, 'POST', '/api/deviations', body(NEW.map((n) => ({ product: n.product, batch: n.batch, from: n.p }))));
    expect(ok.statusCode).toBe(201);
    const d = (await call(t.app, c.us57!, 'GET', `/api/deviations/${ok.json().id}`)).json() as { batches: { typed: boolean | null }[] };
    expect(d.batches.map((b) => b.typed)).toEqual(NEW.map(() => false));
    const wrong = await call(t.app, c.us57!, 'POST', '/api/deviations', body([{ product: 'X', batch: 'TC26001', from: 'truebatch_liquids_packing' }]));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().problems).toEqual(['Batch TC26001 is not in TrueBatch Oral Liquids Packing. Pick it from the list, or type it by hand.']);
    // An unknown product key is not accepted as a pick.
    expect((await call(t.app, c.us57!, 'POST', '/api/deviations', body([{ product: 'X', batch: 'TC26001', from: 'truebatch_unknown' }]))).statusCode).toBe(400);
  });

  it('D-59: the status lists every product; a product without a link is off, not an error', async () => {
    const st = (await call(t.app, c.us57!, 'GET', '/api/data/status')).json() as Record<string, boolean>;
    expect(st).toEqual({ logbook: false, truebatch: true, truebatch_injectables: true, truebatch_packing: true, truebatch_injectables_packing: true,
      truebatch_capsules: true, truebatch_capsules_packing: true, truebatch_liquids: true, truebatch_liquids_packing: true, truebatch_api: true });
  });

  it('D-59: a kept copy names a TrueBatch product (any key of the one list, no migration per product); other sources are refused', async () => {
    const [d] = await t.owner<{ id: number; by: number }[]>`select d.id::int, d.reporter_id::int as by from deviations d order by d.id limit 1`;
    const keep = (source: string) => t.owner`insert into data_fetches (deviation_id, source, status, params, views, data, row_count, sha256, fetched_by)
      values (${d!.id}, ${source}, 'not_configured', '{}', '[]', '{}', 0, 'x', ${d!.by}) returning id`;
    for (const p of ['truebatch_capsules', 'truebatch_liquids_packing', 'truebatch_api', 'truebatch_future_product']) await expect(keep(p)).resolves.toHaveLength(1);
    for (const p of ['mes', 'truebatch_', 'TrueBatch_api', 'truebatch api']) await expect(keep(p)).rejects.toThrow(/data_fetches_source_check/);
  });
});
