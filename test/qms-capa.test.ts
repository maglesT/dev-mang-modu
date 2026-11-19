import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app.js';
import { connect } from '../server/db.js';
import { newCapaUrl, qmsBaseUrl, QMS_OFF, QMS_NEW_CAPA_PATH } from '../server/readers/qms.js';
import { APP_ROLE, TEST_DATABASE_URL, TEST_PROOF_KEY, call, fakePeople, fakeSignOn, freshDb, login, seedUser, sig, type TestApp } from './helpers.js';
import { TOOLS } from './fixtures.js';

// D-63 (owner: "QMS owns CAPA"). A stand-in schema carries the QMS's capa_v1 with its fixed columns. Three apps share one
// database: `t.app` with the QMS linked, `alone` without it (Deviations sold alone), `cut` with the link cut (no grant: 42501).
let t: TestApp;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};
let areaId: number;
let typeId: number;
const tag = Math.random().toString(36).slice(2, 8);
const S = { qms: `qms63_${tag}`, cut: `qmscut63_${tag}` };
const QMS_URL = 'https://qms.example.test';
let reader: ReturnType<typeof connect>;
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
let alone: Awaited<ReturnType<typeof buildApp>>;
let cut: Awaited<ReturnType<typeof buildApp>>;
const inDays = (n: number) => new Date(Date.now() + n * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);

const appWith = async (db: Awaited<ReturnType<typeof freshDb>>, sources: object) => {
  const a = await buildApp({ sql: db.sql, signOn: fakeSignOn(), people: fakePeople(), proofKey: TEST_PROOF_KEY, webRoot: '/nonexistent', sources });
  apps.push(a);
  return a;
};
let seq = 0;
/** A CAPA as the QMS publishes it. */
const qmsCapa = (ref: string | null, status = 'open', over: Record<string, unknown> = {}) => {
  const n = `QCAPA-26-${String(++seq).padStart(3, '0')}`;
  const row = { capa_number: n, title: `Example action ${seq}`, status, status_text: status.replace('_', ' '), source_kind: ref ? 'deviation' : 'audit',
    source_ref: ref ?? 'IA-26-01', owner_name: 'Example Owner', due_date: inDays(20), effective: null, ...over };
  return t.owner.unsafe(`insert into ${S.qms}.capa_v1 (capa_number, title, status, status_text, source_kind, source_ref, owner_name, due_date, effective)
    values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9)`, [row.capa_number, row.title, row.status, row.status_text, row.source_kind, row.source_ref, row.owner_name, row.due_date, row.effective as never]).then(() => n);
};

beforeAll(async () => {
  const db = await freshDb();
  await db.owner.unsafe(`
    create schema ${S.qms}; create schema ${S.cut};
    create table ${S.qms}.capa_v1 (capa_number text, title text, status text, status_text text, source_kind text, source_ref text, owner_name text,
      due_date date, closed_at timestamptz, effective boolean, data_as_of timestamptz default now());
    create table ${S.cut}.capa_v1 (capa_number text);`);
  reader = connect(TEST_DATABASE_URL, { role: APP_ROLE }, 1);
  const app = await appWith(db, { qms: { sql: db.owner, schema: S.qms, url: QMS_URL } });
  alone = await appWith(db, {});
  cut = await appWith(db, { qms: { sql: reader, schema: S.cut, url: QMS_URL } });
  t = { ...db, app, close: async () => { for (const a of apps) await a.close(); await reader.end(); await db.close(); } };
  for (const [u, roles] of [['adm63', ['admin']], ['qa63', ['qa', 'user']], ['us63', ['user']], ['iv63', ['user']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  c.alone = (await login(alone, 'qa63')).cookie;
  c.cut = (await login(cut, 'qa63')).cookie;
  areaId = (await call(t.app, c.adm63!, 'POST', '/api/areas', { name: 'Compression' })).json().id;
  typeId = (await call(t.app, c.adm63!, 'POST', '/api/deviation-types', { name: 'Equipment' })).json().id;
});
afterAll(async () => {
  await t.owner.unsafe(`drop schema ${S.qms} cascade; drop schema ${S.cut} cascade;`);
  await t.close();
});

// A deviation investigated and signed, waiting for closure: its id and number.
async function awaitingClosure(classification = 'major') {
  const id = (await call(t.app, c.us63!, 'POST', '/api/deviations', {
    planned: false, title: 'Tablet weight drift', description: 'Weights drifted high on press 2.', areaId,
    eventAt: new Date(Date.now() - 600_000).toISOString(), products: [{ product: 'Example tablets 10 mg', batch: 'EX-63' }],
    initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'Press stopped.',
  })).json().id as number;
  await call(t.app, c.qa63!, 'POST', `/api/deviations/${id}/classify`, { classification, typeId, impact: 'EX-63.', investigatorId: ids.iv63, productBatchChecked: true });
  const inv = await call(t.app, c.iv63!, 'POST', `/api/deviations/${id}/investigate`, {
    data: { ...TOOLS, rootCause: 'Feeder setting changed.', otherBatches: [], noOtherReason: 'Only this batch ran.', conclusion: 'Sort EX-63.' }, signature: sig('iv63'),
  });
  expect(inv.statusCode, inv.body).toBe(200);
  const d = (await call(t.app, c.qa63!, 'GET', `/api/deviations/${id}`)).json();
  return { id, number: d.number as string };
}
const FINAL = { finalImpact: { productQuality: 'no', patientSafety: 'no', otherBatches: 'no', notes: 'Only the sorted tablets were affected.' } };
const close = (app: typeof alone, cookie: string, id: number, data: object = {}) =>
  call(app, cookie, 'POST', `/api/deviations/${id}/close`, { data: { summary: 'Batch sorted.', ...FINAL, ...data }, signature: sig('qa63') });
const localCapa = (deviationId: number) => ({ source: 'deviation', deviationId, type: 'corrective', strength: 'medium', description: 'Lock the feeder setting.', ownerId: ids.us63, dueDate: inDays(14) });

describe('D-63: QMS owns CAPA while it is linked', () => {
  it('DV-08: the new-CAPA link is the QMS screen pre-filled with the deviation number; the QMS address is set or found beside this app', () => {
    expect(newCapaUrl(QMS_URL, 'DEV-2026-0007')).toBe(`${QMS_URL}${QMS_NEW_CAPA_PATH}?source=deviation&ref=DEV-2026-0007`);
    expect(newCapaUrl(QMS_URL)).toBe(`${QMS_URL}${QMS_NEW_CAPA_PATH}`);
    expect(newCapaUrl(undefined, 'DEV-2026-0007')).toBeNull();
    expect(qmsBaseUrl(undefined, 'https://deviations.plant.example/cb')).toBe('https://qms.plant.example');
    expect(qmsBaseUrl('https://quality.example/', 'https://deviations.plant.example/cb')).toBe('https://quality.example');
    expect(qmsBaseUrl(undefined, 'https://dev.example/cb')).toBeUndefined();
  });

  it('DV-08: no local CAPA is raised while the QMS is linked; the deviation shows its QMS CAPAs read-only, with the link to raise one in QMS', async () => {
    const { id, number } = await awaitingClosure();
    const res = await call(t.app, c.qa63!, 'POST', '/api/capas', localCapa(id));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('capa_in_qms');
    expect((await call(t.app, c.qa63!, 'GET', `/api/capas?deviationId=${id}&status=all`)).json()).toEqual([]);
    const mine = await qmsCapa(number, 'in_progress');
    await qmsCapa('DEV-2026-9999');   // another deviation's
    await qmsCapa(null);              // an audit CAPA
    const q = (await call(t.app, c.us63!, 'GET', `/api/qms/capas?deviationId=${id}`)).json();
    expect(q).toMatchObject({ linked: true, off: false, newCapaUrl: `${QMS_URL}${QMS_NEW_CAPA_PATH}?source=deviation&ref=${number}` });
    expect(q.capas.map((x: { capa_number: string }) => x.capa_number)).toEqual([mine]);
    expect(q.capas[0]).toMatchObject({ status_text: 'in progress', owner_name: 'Example Owner', effective: null });
    // The QMS register on the CAPA list; only "is it linked" without a scope.
    const reg = (await call(t.app, c.us63!, 'GET', '/api/qms/capas?register=1')).json();
    expect(reg.capas.length).toBeGreaterThanOrEqual(3);
    expect((await call(t.app, c.us63!, 'GET', '/api/qms/capas')).json()).toMatchObject({ linked: true, capas: [], newCapaUrl: `${QMS_URL}${QMS_NEW_CAPA_PATH}` });
  });

  it('DV-08: open CAPAs are one number: the QMS ones are counted on the deviation, the list and the batch lookup; closed and cancelled are not', async () => {
    const { id, number } = await awaitingClosure();
    await qmsCapa(number, 'open');
    await qmsCapa(number, 'effectiveness_check');
    await qmsCapa(number, 'closed');
    await qmsCapa(number, 'cancelled');
    expect((await call(t.app, c.qa63!, 'GET', `/api/deviations/${id}`)).json().openCapas).toBe(2);
    const row = (await call(t.app, c.qa63!, 'GET', '/api/deviations?view=all')).json().find((r: { id: number }) => r.id === id);
    expect(row.openCapas).toBe(2);
    const lookup = (await call(t.app, c.qa63!, 'GET', '/api/batch-lookup?batch=EX-63')).json().find((r: { id: number }) => r.id === id);
    expect(lookup.openCapas).toBe(2);
    // Sold alone: the QMS is not read.
    expect((await call(alone, c.alone!, 'GET', `/api/deviations/${id}`)).json().openCapas).toBe(0);
  });

  it('DV-10: closure needs a CAPA of a major deviation checked once against the QMS CAPAs (a cancelled one does not count), kept with the closure', async () => {
    const { id, number } = await awaitingClosure();
    await qmsCapa(number, 'cancelled');
    const refused = await close(t.app, c.qa63!, id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('capa_required');
    const n = await qmsCapa(number, 'open');
    const ok = await close(t.app, c.qa63!, id);
    expect(ok.statusCode, ok.body).toBe(200);
    const d = (await call(t.app, c.qa63!, 'GET', `/api/deviations/${id}`)).json();
    const closure = d.sections.find((s: { kind: string; latest: boolean }) => s.kind === 'closure' && s.latest);
    expect(closure.data.qmsCapas).toEqual([n]);
    expect(closure.data.noCapaReason).toBe('');
  });

  it('DV-10: a minor deviation with a QMS CAPA needs no "no CAPA" reason; without one it does', async () => {
    const a = await awaitingClosure('minor');
    expect((await close(t.app, c.qa63!, a.id)).statusCode).toBe(400);
    expect((await close(t.app, c.qa63!, a.id, { noCapaReason: 'Immediate sort was enough.' })).statusCode).toBe(200);
    const b = await awaitingClosure('minor');
    await qmsCapa(b.number, 'open');
    expect((await close(t.app, c.qa63!, b.id)).statusCode).toBe(200);
  });

  it('DV-08: the link off: "QMS link off" is shown, no local CAPA is raised (try again) and closure waits for the QMS', async () => {
    const { id } = await awaitingClosure();
    const q = (await call(cut, c.cut!, 'GET', `/api/qms/capas?deviationId=${id}`)).json();
    expect(q).toMatchObject({ linked: true, off: true, note: QMS_OFF, capas: [] });
    const raise = await call(cut, c.cut!, 'POST', '/api/capas', localCapa(id));
    expect(raise.statusCode).toBe(503);
    expect(raise.json().problems).toEqual([QMS_OFF]);
    const shut = await close(cut, c.cut!, id, { noCapaReason: 'x' });
    expect(shut.statusCode).toBe(503);
    expect(shut.json().problems).toEqual([QMS_OFF]);
    // The deviation still opens; its count is the local one.
    expect((await call(cut, c.cut!, 'GET', `/api/deviations/${id}`)).statusCode).toBe(200);
  });

  it('DV-08: sold alone, CAPAs work as before; local CAPAs raised then stay readable and count once the QMS is linked', async () => {
    const { id, number } = await awaitingClosure();
    expect((await call(alone, c.alone!, 'GET', '/api/qms/capas')).json()).toMatchObject({ linked: false, capas: [] });
    const r = await call(alone, c.alone!, 'POST', '/api/capas', localCapa(id));
    expect(r.statusCode, r.body).toBe(201);
    // Now the QMS is linked: the old local CAPA is still listed and opens, and counts beside the QMS ones.
    expect((await call(t.app, c.qa63!, 'GET', `/api/capas?deviationId=${id}&status=all`)).json()).toHaveLength(1);
    expect((await call(t.app, c.qa63!, 'GET', `/api/capas/${r.json().id}`)).statusCode).toBe(200);
    await qmsCapa(number, 'open');
    expect((await call(t.app, c.qa63!, 'GET', `/api/deviations/${id}`)).json().openCapas).toBe(2);
    // It is still published in this app's own capa_v1 for the QMS.
    const [pub] = await t.owner.unsafe(`select status, deviation_number from ${(await t.owner`select current_schema() as s`)[0]!.s}_report.capa_v1 where number = $1`, [r.json().number]);
    expect(pub).toMatchObject({ status: 'open', deviation_number: number });
    expect((await close(t.app, c.qa63!, id)).statusCode).toBe(200);
  });
});
