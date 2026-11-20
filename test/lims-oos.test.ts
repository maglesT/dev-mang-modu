import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app.js';
import { connect } from '../server/db.js';
import { LIMS_AREA, LIMS_AREA_OFF, LIMS_OFF, PHASE_I_DONE, resultText } from '../server/readers/lims.js';
import { APP_ROLE, TEST_DATABASE_URL, TEST_PROOF_KEY, call, fakePeople, fakeSignOn, freshDb, login, seedUser, type TestApp } from './helpers.js';

// D-60: QA files the phase II investigation of a LIMS OOS by picking it from LIMS's report.oos_v1. A stand-in schema
// carries the view's columns (LIMS migration 0010; outside_lab at the end, migration 0022): OOS1 and OOS2 need phase II,
// OOS3 is still in phase I, OOS4 already names a phase II deviation in LIMS, OOS5 is concluded (not listed). D-61: LIMS's
// `shown` carries the unit ("91.2 %"); OOS2 has no shown text (null) and OOS3 an empty one, so value and unit are used.
let t: TestApp;
const c: Record<string, string> = {};
let areaId: number;
let typeId: number;
let qa2: number;
const tag = Math.random().toString(36).slice(2, 8);
const S = { lims: `lims60_${tag}`, cut: `limscut60_${tag}`, em: `limsem60_${tag}` };
const ID = { o1: randomUUID(), o2: randomUUID(), o3: randomUUID(), o4: randomUUID(), o5: randomUUID(), em: randomUUID() };
const opened = new Date(Date.now() - 26 * 3_600_000).toISOString();
let reader: ReturnType<typeof connect>;
let apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function standIn(o: TestApp['owner']) {
  await o.unsafe(`
    create schema ${S.lims}; create schema ${S.cut};
    create table ${S.lims}.oos_v1 (oos_id uuid, oos_number text, sample_number text, lot_number text, item_kind text, item_master_id text,
      item_code text, item_name text, analysis_number text, test_key text, test_name text, value numeric, unit text, shown text, limit_text text,
      status text, phase_ii_needed boolean, deviation_number text, opened_at timestamptz, closed_at timestamptz,
      read_at timestamptz default now(), data_as_of timestamptz default now(), outside_lab text);
    insert into ${S.lims}.oos_v1 (oos_id, oos_number, sample_number, lot_number, item_kind, item_code, item_name, analysis_number, test_key, test_name,
      value, unit, shown, limit_text, status, phase_ii_needed, deviation_number, opened_at) values
      ('${ID.o1}', 'OOS260001', 'LS2600011', 'EX26001', 'PRODUCT', 'FG-EX-10', 'Example tablets 10 mg', 'LA2600021', 'assay', 'Assay', 91.2, '%', '91.2 %', '95.0 to 105.0 %', 'OPEN', true, null, '${opened}'),
      ('${ID.o2}', 'OOS260002', 'LS2600012', 'RM-LOT-77', 'MATERIAL', 'RM-EX-01', 'Example excipient', 'LA2600022', 'water', 'Water content', 6.4, '%', null, 'NMT 5.0 %', 'OPEN', true, null, now()),
      ('${ID.o3}', 'OOS260003', 'LS2600013', 'EX26002', 'PRODUCT', 'FG-EX-10', 'Example tablets 10 mg', 'LA2600023', 'diss', 'Dissolution', 71, '%', '', 'Q = 80 %', 'OPEN', false, null, now()),
      ('${ID.o4}', 'OOS260004', 'LS2600014', 'EX26003', 'PRODUCT', 'FG-EX-10', 'Example tablets 10 mg', 'LA2600024', 'assay', 'Assay', 106.1, '%', '106.1 %', '95.0 to 105.0 %', 'OPEN', true, 'DEV-2026-9001', now()),
      ('${ID.o5}', 'OOS260005', 'LS2600015', 'EX26004', 'PRODUCT', 'FG-EX-10', 'Example tablets 10 mg', 'LA2600025', 'assay', 'Assay', 94.0, '%', '94.0 %', '95.0 to 105.0 %', 'INVALIDATED', false, null, now());
    create table ${S.cut}.oos_v1 (oos_id uuid);
    -- LIMS migration 0031: an environmental-monitoring OOS names its batch, point and room (columns at the end).
    create schema ${S.em};
    create table ${S.em}.oos_v1 as select * from ${S.lims}.oos_v1 where false;
    alter table ${S.em}.oos_v1 add column batch_number text, add column point_code text, add column room_code text;
    insert into ${S.em}.oos_v1 (oos_id, oos_number, sample_number, lot_number, item_kind, item_code, item_name, analysis_number, test_key, test_name,
      value, unit, shown, limit_text, status, phase_ii_needed, deviation_number, opened_at, batch_number, point_code, room_code) values
      ('${ID.em}', 'OOS260009', 'LS2600019', 'RM9-CP1', 'ROOM', 'RM-9', 'Example filling room', 'LA2600029', 'cp', 'Contact plate, grade B (CFU/plate)',
       7, 'CFU', '7 CFU', 'NMT 5 CFU', 'OPEN', true, null, '${opened}', 'TI26009', 'RM9-CP1', 'RM-9');
  `);
}

const appWith = async (db: Awaited<ReturnType<typeof freshDb>>, sources: object) => {
  const a = await buildApp({ sql: db.sql, signOn: fakeSignOn(), people: fakePeople(), proofKey: TEST_PROOF_KEY, webRoot: '/nonexistent', sources });
  apps.push(a);
  return a;
};
let off: Awaited<ReturnType<typeof buildApp>>;   // LIMS not linked
let cut: Awaited<ReturnType<typeof buildApp>>;   // the link cut (no grant: 42501)

beforeAll(async () => {
  const db = await freshDb();
  await standIn(db.owner);
  reader = connect(TEST_DATABASE_URL, { role: APP_ROLE }, 1);
  const app = await appWith(db, { lims: { sql: db.owner, schema: S.lims } });
  off = await appWith(db, {});
  cut = await appWith(db, { lims: { sql: reader, schema: S.cut } });
  t = { ...db, app, close: async () => { for (const a of apps) await a.close(); await reader.end(); await db.close(); } };
  for (const [u, roles] of [['adm60', ['admin']], ['qa60', ['qa', 'user']], ['qb60', ['qa', 'user']], ['us60', ['user']]] as const) {
    const id = await seedUser(t.owner, u, [...roles]);
    if (u === 'qb60') qa2 = id;
    c[u] = (await login(t.app, u)).cookie;
  }
  c.off = (await login(off, 'qa60')).cookie;
  c.cut = (await login(cut, 'qa60')).cookie;
  areaId = (await call(t.app, c.adm60!, 'POST', '/api/areas', { name: 'QC laboratory' })).json().id;
  typeId = (await call(t.app, c.adm60!, 'POST', '/api/deviation-types', { name: 'Laboratory / OOS' })).json().id;
});
afterAll(async () => {
  await t.owner.unsafe(`drop schema ${S.lims} cascade; drop schema ${S.cut} cascade; drop schema ${S.em} cascade;`);
  await t.close();
});

// What the form sends after the pick: the OOS id, and the texts it filled (any product rows are replaced by the OOS lot).
const body = (oosId: string, over: object = {}) => ({
  planned: false, title: 'OOS phase II', description: 'Phase II investigation of the OOS.', areaId, equipment: '', eventAt: opened,
  products: [], noBatch: false, oos: { id: oosId }, immediateAction: 'Lot on hold in QC.',
  initialImpact: { productQuality: 'yes', patientSafety: 'unknown', otherBatches: 'unknown', notes: 'Lot on hold.' }, ...over,
});
type Pick = { id: string; number: string; lot: string; itemCode: string; test: string; result: string; limit: string; phaseI: string; phaseII: boolean; filed: string | null };
const list = async (cookie = c.qa60!, app = t.app) => (await call(app, cookie, 'GET', '/api/oos')).json() as { linked: boolean; oos: Pick[]; note: string | null };

describe('OOS phase II from LIMS (D-60)', () => {

  it('D-61: the result is LIMS\'s shown text as it is; only without it is it the value and the unit', () => {
    expect(resultText({ shown: '0.9 %', value: '0.9', unit: '%' })).toBe('0.9 %');
    expect(resultText({ shown: ' Complies ', value: null, unit: null })).toBe('Complies');
    expect(resultText({ shown: '', value: '0.9', unit: '%' })).toBe('0.9 %');
    expect(resultText({ shown: null, value: '12', unit: null })).toBe('12');
    expect(resultText({ shown: null, value: null, unit: null })).toBe('');
  });

  it('DV-23: the OOS list holds the open OOS of LIMS with their result, limit and phase I outcome; concluded ones are not listed', async () => {
    const l = await list();
    expect(l).toMatchObject({ linked: true, note: null });
    expect(l.oos.map((o) => o.number).sort()).toEqual(['OOS260001', 'OOS260002', 'OOS260003', 'OOS260004']);
    expect(l.oos.find((o) => o.number === 'OOS260001')).toMatchObject({ id: ID.o1, lot: 'EX26001', itemCode: 'FG-EX-10', test: 'Assay', result: '91.2 %',
      limit: '95.0 to 105.0 %', phaseI: PHASE_I_DONE, phaseII: true, filed: null });
    expect(l.oos.find((o) => o.number === 'OOS260003')).toMatchObject({ phaseII: false, filed: null, result: '71 %' });
    // D-61: LIMS's shown text is the result as reported, unit included, so the unit is not added again; without it, value and unit.
    expect(l.oos.find((o) => o.number === 'OOS260002')).toMatchObject({ result: '6.4 %' });
    // LIMS names a phase II deviation for OOS260004 already.
    expect(l.oos.find((o) => o.number === 'OOS260004')).toMatchObject({ filed: 'DEV-2026-9001' });
  });

  it('DV-01: a picked OOS is filed once: product, lot, test, result, limit, phase I and the OOS number come from LIMS, not from the form', async () => {
    // D-61: the QC laboratory area of LIMS is not there before the first OOS is filed.
    expect(await t.owner`select 1 from areas where name = ${LIMS_AREA}`).toHaveLength(0);
    // Texts typed over the pulled facts are not taken: the OOS is read from LIMS and its lot replaces any product row.
    const res = await call(t.app, c.qa60!, 'POST', '/api/deviations', body(ID.o1, {
      products: [{ product: 'Typed product', batch: 'TYPED-1', from: 'lims' }], oos: { id: ID.o1, number: 'OOS999', result: '100 %' } }));
    expect(res.statusCode, res.body).toBe(201);
    const { id, number } = res.json() as { id: number; number: string };
    const [dev] = await t.owner<{ source_ref: string; data: Record<string, unknown> }[]>`
      select d.source_ref, r.data from deviations d join latest_sections r on r.deviation_id = d.id and r.kind = 'report' where d.id = ${id}`;
    expect(dev!.source_ref).toBe(`lims:oos:${ID.o1}`);
    expect(dev!.data.oos).toEqual({ id: ID.o1, number: 'OOS260001', sample: 'LS2600011', lot: 'EX26001', itemKind: 'product', itemCode: 'FG-EX-10',
      itemName: 'Example tablets 10 mg', analysis: 'LA2600021', test: 'Assay', result: '91.2 %', limit: '95.0 to 105.0 %', phaseI: PHASE_I_DONE, openedAt: opened });
    expect(dev!.data.products).toEqual([{ product: 'FG-EX-10', batch: 'EX26001', from: 'lims' }]);
    // D-61: picking the OOS set the area (the form sent another one): the QC laboratory area, made now, once, audited as automatic.
    const made = await t.owner<{ id: number; active: boolean }[]>`select id::int, active from areas where name = ${LIMS_AREA}`;
    expect(made).toHaveLength(1);
    expect(made[0]!.active).toBe(true);
    expect(dev!.data.areaId).toBe(made[0]!.id);
    expect(dev!.data.areaId).not.toBe(areaId);
    const created = await t.owner<{ actor_id: number; new_value: object }[]>`
      select actor_id::int, new_value from audit_log where action = 'area.created' and object_id = ${String(made[0]!.id)}`;
    expect(created).toEqual([{ actor_id: expect.any(Number), new_value: { name: LIMS_AREA, automatic: true } }]);
    expect((await call(t.app, c.qa60!, 'GET', `/api/deviations/${id}`)).json().area).toBe(LIMS_AREA);
    // The lot was pulled, not typed: QA classifies without the product and batch tick (D-58).
    const d = (await call(t.app, c.qa60!, 'GET', `/api/deviations/${id}`)).json();
    expect(d.batches).toEqual([{ role: 'own', product: 'FG-EX-10', batch: 'EX26001', outcome: null, typed: false }]);
    const cls = await call(t.app, c.qb60!, 'POST', `/api/deviations/${id}/classify`, { classification: 'major', typeId, impact: 'Lot on hold.', investigatorId: qa2 });
    expect(cls.statusCode, cls.body).toBe(200);
    // The list marks it, and a second filing of the same OOS is refused, naming the deviation.
    expect((await list()).oos.find((o) => o.id === ID.o1)!.filed).toBe(number);
    const again = await call(t.app, c.qb60!, 'POST', '/api/deviations', body(ID.o1));
    expect(again.statusCode).toBe(400);
    expect(again.json().problems).toEqual([`OOS260001 already has deviation ${number}. Open that deviation instead.`]);
    // LIMS sees it in deviation_v1: the OOS lot as its batch and the OOS as its source.
    const [s] = await t.owner<{ s: string }[]>`select current_schema() as s`;
    const [v] = await t.owner.unsafe(`select batch, source_ref from ${s!.s}_report.deviation_v1 where number = $1`, [number]);
    expect(v).toEqual({ batch: 'EX26001', source_ref: `lims:oos:${ID.o1}` });
  });

  it('DV-01: an OOS without phase II, one LIMS already names a deviation for, an unknown one, and a planned OOS deviation are refused', async () => {
    const refused = async (b: object) => { const r = await call(t.app, c.qa60!, 'POST', '/api/deviations', b); expect(r.statusCode).toBe(400); return r.json().problems as string[]; };
    expect(await refused(body(ID.o3))).toEqual([expect.stringMatching(/^OOS260003: No phase II now: phase I is not finished/)]);
    expect(await refused(body(ID.o4))).toEqual(['OOS260004 already has deviation DEV-2026-9001 in LIMS. Open that deviation instead.']);
    expect(await refused(body(ID.o5))).toEqual(['OOS260005 is concluded in LIMS (invalidated): no phase II is filed for it.']);
    expect(await refused(body(randomUUID()))).toEqual(['This OOS is not in LIMS. Pick it from the list again.']);
    expect(await refused(body(ID.o2, { planned: true, plannedReason: 'x' }))).toEqual(['An OOS phase II investigation is an unplanned deviation.']);
    // A lot "from LIMS" without its OOS is not accepted.
    expect(await refused(body(ID.o2, { oos: undefined, products: [{ product: 'RM-EX-01', batch: 'RM-LOT-77', from: 'lims' }] })))
      .toEqual(['A lot from LIMS comes only with its OOS: pick the OOS.']);
    expect((await t.owner`select 1 from deviations where source_ref like 'lims:oos:%' and source_ref <> ${`lims:oos:${ID.o1}`}`).length).toBe(0);
  });

  it('DV-23: without the LIMS link nothing is listed and no OOS can be picked; a cut link says so in plain words', async () => {
    expect(await list(c.off!, off)).toEqual({ linked: false, oos: [], note: null });
    const r = await call(off, c.off!, 'POST', '/api/deviations', body(ID.o2));
    expect(r.json().problems).toEqual(['LIMS is not connected on this installation, so an OOS cannot be picked.']);
    expect(await list(c.cut!, cut)).toEqual({ linked: true, oos: [], note: LIMS_OFF });
    expect((await call(cut, c.cut!, 'POST', '/api/deviations', body(ID.o2))).json().problems).toEqual([LIMS_OFF]);
    // A plain report is filed as before on both.
    const plain = { ...body(ID.o2), oos: undefined, products: [], noBatch: true };
    expect((await call(off, c.off!, 'POST', '/api/deviations', plain)).statusCode).toBe(201);
  });

  it('DV-14: a correction keeps the OOS and its lot as read from LIMS; an OOS cannot be added by a correction', async () => {
    const res = await call(t.app, c.us60!, 'POST', '/api/deviations', body(ID.o2, { products: [{ product: 'FG-EX-10', batch: 'EX26009' }] }));
    expect(res.statusCode, res.body).toBe(201);
    const { id } = res.json() as { id: number };
    const report = async () => (await t.owner<{ data: { oos: { number: string }; products: object[] } }[]>`
      select data from latest_sections where deviation_id = ${id} and kind = 'report'`)[0]!.data;
    const first = await report();
    expect(first.products).toEqual([{ product: 'RM-EX-01', batch: 'RM-LOT-77', from: 'lims' }, { product: 'FG-EX-10', batch: 'EX26009' }]);
    // The form sends the OOS back changed and drops the lot: the OOS and its lot stay as they were.
    const fix = await call(t.app, c.us60!, 'POST', `/api/deviations/${id}/correct`, { kind: 'report', reason: 'Title clearer', data: body(ID.o2, {
      title: 'OOS260002 water content phase II', oos: { ...first.oos, id: ID.o3, number: 'OOS260003' }, products: [{ product: 'FG-EX-10', batch: 'EX26009' }] }) });
    expect(fix.statusCode, fix.body).toBe(200);
    const now = await report();
    expect(now.oos).toEqual(first.oos);
    expect(now.products).toEqual(first.products);
    // A deviation filed without an OOS does not get one later.
    const plain = await call(t.app, c.us60!, 'POST', '/api/deviations', { ...body(ID.o2), oos: undefined, products: [], noBatch: true });
    const add = await call(t.app, c.us60!, 'POST', `/api/deviations/${plain.json().id}/correct`, { kind: 'report', reason: 'Is an OOS', data: body(ID.o2) });
    expect(add.json().problems).toEqual(['An OOS is picked only when the deviation is reported.']);
  });

  it('D-61: a second OOS report reuses the QC laboratory area; a plain report still needs an area chosen; an inactive area stops OOS filing', async () => {
    const [lab] = await t.owner<{ id: number }[]>`select id::int from areas where name = ${LIMS_AREA}`;
    // OOS260002 was filed in the correction test above, without the area made again.
    const [d2] = await t.owner<{ area: number }[]>`
      select (r.data->>'areaId')::int as area from deviations d join latest_sections r on r.deviation_id = d.id and r.kind = 'report'
      where d.source_ref = ${`lims:oos:${ID.o2}`}`;
    expect(d2!.area).toBe(lab!.id);
    expect(await t.owner`select 1 from areas where name = ${LIMS_AREA}`).toHaveLength(1);
    expect(await t.owner`select 1 from audit_log where action = 'area.created' and new_value->>'name' = ${LIMS_AREA}`).toHaveLength(1);
    // An OOS report needs no area from the form; a plain report does, and keeps the area chosen.
    const o6 = randomUUID();
    await t.owner.unsafe(`insert into ${S.lims}.oos_v1 (oos_id, oos_number, sample_number, lot_number, item_kind, item_code, item_name, analysis_number,
      test_name, value, unit, shown, limit_text, status, phase_ii_needed, opened_at)
      values ('${o6}', 'OOS260006', 'LS2600016', 'EX26006', 'PRODUCT', 'FG-EX-10', 'Example tablets 10 mg', 'LA2600026', 'Assay', 93.0, '%', '93.0 %',
      '95.0 to 105.0 %', 'OPEN', true, now())`);
    const plain = { ...body(o6), oos: undefined, products: [], noBatch: true };
    const none = await call(t.app, c.us60!, 'POST', '/api/deviations', { ...plain, areaId: undefined });
    expect(none.statusCode).toBe(400);
    expect(none.json().problems).toEqual(['Choose an area from the list.']);
    const p = await call(t.app, c.us60!, 'POST', '/api/deviations', plain);
    expect((await call(t.app, c.us60!, 'GET', `/api/deviations/${p.json().id}`)).json().area).toBe('QC laboratory');
    // An administrator made the area inactive: an OOS is not filed, and the area is not made again.
    await t.owner`update areas set active = false where id = ${lab!.id}`;
    const off6 = await call(t.app, c.qa60!, 'POST', '/api/deviations', body(o6, { areaId: undefined }));
    expect(off6.statusCode).toBe(400);
    expect(off6.json().problems).toEqual([LIMS_AREA_OFF]);
    expect(await t.owner`select 1 from areas where name = ${LIMS_AREA}`).toHaveLength(1);
    await t.owner`update areas set active = true where id = ${lab!.id}`;
    const ok6 = await call(t.app, c.qa60!, 'POST', '/api/deviations', body(o6, { areaId: undefined }));
    expect(ok6.statusCode, ok6.body).toBe(201);
    expect((await call(t.app, c.qa60!, 'GET', `/api/deviations/${ok6.json().id}`)).json().area).toBe(LIMS_AREA);
  });

  it('display 19 Nov: an EM OOS (LIMS 0031 columns) names point, room and batch, and is filed in its room', async () => {
    const em = await appWith(t, { lims: { sql: t.owner, schema: S.em } });
    const cookie = (await login(em, 'qa60')).cookie;
    const res = await call(em, cookie, 'POST', '/api/deviations', body(ID.em));
    expect(res.statusCode, res.body).toBe(201);
    const { id } = res.json() as { id: number };
    const [dev] = await t.owner<{ area: string; data: Record<string, unknown> }[]>`
      select a.name as area, r.data from deviations d join latest_sections r on r.deviation_id = d.id and r.kind = 'report' join areas a on a.id = (r.data->>'areaId')::int where d.id = ${id}`;
    expect(dev!.area).toBe('RM-9 Example filling room');
    expect(dev!.data.oos).toMatchObject({ number: 'OOS260009', lot: 'RM9-CP1', batch: 'TI26009', point: 'RM9-CP1', room: 'RM-9' });
    expect(dev!.data.products).toEqual([{ product: 'RM-9', batch: 'TI26009', from: 'lims' }]);
  });
});
