import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../server/db.js';
import { CONNECTION_OFF } from '../server/people.js';
import { LOGBOOK_OFF, fetchRelated } from '../server/readers/fetch.js';
import { APP_ROLE, TEST_DATABASE_URL, call, directory, fakePeople, freshApp, login, seedUser, type FakePeople, type TestApp } from './helpers.js';

// D-42 slice 4 (platform PL-08, recipe §4, A11 5): links to core's employee view and to the Logbook.
let t: TestApp;
let people: FakePeople;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};
let areaId: number;
let typeId: number;
const inDays = (n: number) => new Date(Date.now() + n * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);

beforeAll(async () => {
  people = fakePeople();
  t = await freshApp({ people });
  for (const [u, roles] of [['lkadmin', ['admin']], ['lkqa', ['qa', 'user']], ['lkus', ['user']], ['lkgone', ['user']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  areaId = (await call(t.app, c.lkadmin!, 'POST', '/api/areas', { name: 'Granulation' })).json().id;
  typeId = (await call(t.app, c.lkadmin!, 'POST', '/api/deviation-types', { name: 'Equipment' })).json().id;
});
afterAll(() => t.close());

const report = async () => (await call(t.app, c.lkus!, 'POST', '/api/deviations', {
  planned: false, title: 'Granulator stopped', description: 'Granulator tripped mid-batch.', areaId,
  eventAt: new Date(Date.now() - 600_000).toISOString(), products: [{ product: 'Metformin 500', batch: 'MET-1' }],
  initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'no', notes: 'Being assessed.' }, immediateAction: 'Batch on hold.',
})).json().id as number;
const classify = (id: number, investigatorId: number) => call(t.app, c.lkqa!, 'POST', `/api/deviations/${id}/classify`,
  { classification: 'minor', typeId, impact: 'MET-1 only.', investigatorId, productBatchChecked: true });
const raise = (ownerId: number) => call(t.app, c.lkqa!, 'POST', '/api/capas',
  { source: 'other', sourceRef: 'Walk-through 3', type: 'corrective', strength: 'medium', description: 'Fix the trip setting.', ownerId, dueDate: inDays(14) });

describe('people through core (PL-08)', () => {
  it('PL-08 refuses an inactive or unknown item: an investigator or CAPA owner core lists as inactive, or does not know, is refused at write', async () => {
    directory.get('lkgone')!.active = false;          // deactivated in core
    const [stranger] = await t.owner<{ id: number }[]>`
      insert into users (employee_id, username, full_name, password_hash, must_change_password)
      values (${randomUUID()}, 'lkstranger', 'Not in core', '-', false) returning id::int`;
    for (const who of [ids.lkgone!, stranger!.id]) {
      expect((await classify(await report(), who)).statusCode).toBe(400);
      expect((await raise(who)).statusCode).toBe(400);
    }
    // An active person is accepted, and the pick list shows only people core lists as active.
    expect((await classify(await report(), ids.lkus!)).statusCode).toBe(200);
    expect((await raise(ids.lkus!)).statusCode).toBe(201);
    const list = (await call(t.app, c.lkqa!, 'GET', '/api/people')).json() as { username: string }[];
    expect(list.map((p) => p.username)).toContain('lkus');
    expect(list.map((p) => p.username)).not.toContain('lkgone');
    expect(list.map((p) => p.username)).not.toContain('lkstranger');
  });

  it('PL-08 connection off: with the link to core cut, assigning and the pick list stop with "Connection to core is off"', async () => {
    people.cut = true;
    try {
      const res = await classify(await report(), ids.lkus!);
      expect(res.statusCode).toBe(503);
      expect(res.json().message).toBe(CONNECTION_OFF);
      expect((await raise(ids.lkus!)).statusCode).toBe(503);
      expect((await call(t.app, c.lkqa!, 'GET', '/api/people')).statusCode).toBe(503);
    } finally {
      people.cut = false;
    }
  });
});

describe('the Logbook link (PL-08)', () => {
  it('PL-08 connection off: a Logbook link without its grant is stored and shown as "Connection to Logbook is off", nothing else is read', async () => {
    // The app's own login reading a schema it holds no grant on: what a cut link looks like on the platform (42501).
    const schema = `lbcut_${process.pid}`;
    await t.owner.unsafe(`create schema ${schema}`);
    const reader = connect(TEST_DATABASE_URL, { role: APP_ROLE }, 1);
    try {
      const id = await report();
      await fetchRelated(t.sql, { logbook: { sql: reader, schema } }, id, ids.lkus!);
      const [row] = await t.owner<{ status: string; error: string; row_count: number }[]>`
        select status, error, row_count from data_fetches where deviation_id = ${id} and source = 'logbook'`;
      expect(row).toMatchObject({ status: 'failed', error: LOGBOOK_OFF, row_count: 0 });
    } finally {
      await reader.end();
      await t.owner.unsafe(`drop schema ${schema} cascade`);
    }
  });
});
