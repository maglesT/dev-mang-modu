import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { fileLogbookOverdue } from '../server/autoraise.js';
import { PERMISSIONS } from '../server/auth.js';
import { APP_ROLE, TEST_DATABASE_URL, call, directory, freshApp, login, proofFor, seedUser, sig, type TestApp } from './helpers.js';

// D-67 (owner, 20 Nov 2026): QA cancels a report as "not a deviation" before the investigation is signed, with a reason
// and one e-signature. The record is kept; it leaves the open and overdue lists and the trends; deviation_v1 says 'cancelled'.
let t: TestApp;
let schema: string;
let reader: Sql;
const lb = `lbcancel_${process.pid}`;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};
let areaId: number;
let typeId: number;

beforeAll(async () => {
  t = await freshApp();
  schema = (await t.owner<{ schema: string }[]>`select current_schema() as schema`)[0]!.schema;
  for (const [u, roles] of [['admin1', ['admin']], ['qa1', ['qa', 'user']], ['qa2', ['qa', 'user']], ['us1', ['user']], ['us2', ['user']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  areaId = (await call(t.app, c.admin1!, 'POST', '/api/areas', { name: 'Compression' })).json().id;
  typeId = (await call(t.app, c.admin1!, 'POST', '/api/deviation-types', { name: 'Process' })).json().id;
  // A stand-in for the Logbook's report.overdue_v1 (as in test/autoraise.test.ts).
  await t.owner.unsafe(`create schema ${lb}`);
  await t.owner.unsafe(`create table ${lb}.overdue_v1 (event_id bigint, equipment_code text, kind text, due_at timestamptz, detected_at timestamptz,
    title text, description text, immediate_action text, impact_notes text, decision text, sent_at timestamptz)`);
  await t.owner.unsafe(`grant usage on schema ${lb} to ${APP_ROLE}; grant select on ${lb}.overdue_v1 to ${APP_ROLE}`);
  reader = connect(TEST_DATABASE_URL, { role: APP_ROLE }, 1);
});
afterAll(async () => {
  await reader?.end();
  await t.owner.unsafe(`drop schema if exists ${lb} cascade`);
  await t.close();
});

const report = (over: object = {}) => ({
  planned: false, title: 'Tablet weight check missed', description: 'The hourly weight check was not written at 10:00.', areaId,
  eventAt: new Date(Date.now() - 3600_000).toISOString(), products: [{ product: 'Cancel Tablets 10 mg', batch: 'CT-001' }],
  initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'no', notes: 'Being checked.' }, immediateAction: 'Supervisor informed.',
  ...over,
});
const file = async (over: object = {}) => {
  const res = await call(t.app, c.us1!, 'POST', '/api/deviations', report(over));
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: number; number: string };
};
const get = async (id: number) => (await call(t.app, c.qa1!, 'GET', `/api/deviations/${id}`)).json();
const cancel = (user: string, id: number, reason = 'The check was written on the paper log at 10:00; it was copied late, not missed.') =>
  call(t.app, c[user]!, 'POST', `/api/deviations/${id}/cancel`, { reason, signature: sig(user) });
const list = async (view: string) => ((await call(t.app, c.qa1!, 'GET', `/api/deviations?view=${view}`)).json() as { number: string }[]).map((d) => d.number);

describe('not a deviation (D-67)', () => {
  it('the right is its own per-employee code', () => {
    expect(PERMISSIONS['deviations.report.cancel']).toBe('Cancel a report as not a deviation (reason and e-signature)');
  });

  it('QA cancels a report awaiting classification: reason and one signature; the record stays, with who, when and why', async () => {
    const { id, number } = await file();
    expect((await call(t.app, c.us2!, 'POST', `/api/deviations/${id}/cancel`, { reason: 'x', signature: sig('us2') })).statusCode).toBe(403);
    expect((await cancel('us1', id)).statusCode).toBe(403);        // a plain user has no right
    expect((await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/cancel`, { reason: ' ', signature: sig('qa1') })).statusCode).toBe(400);
    const res = await cancel('qa1', id);
    expect(res.statusCode, res.body).toBe(200);
    const d = await get(id);
    expect(d.step).toBe('cancelled');
    const s = d.sections.find((x: { kind: string }) => x.kind === 'cancellation');
    expect(s.data).toEqual({ notADeviation: true, reason: expect.stringMatching(/copied late/), stepBefore: 'classification' });
    expect(d.signatures).toEqual([expect.objectContaining({ sectionId: s.id, meaning: 'cancelled', printedName: 'QA1' })]);
    expect(d.history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['deviation.cancelled', 'signed.cancelled']));
    // Kept, not deleted; listed under its own filter and in "all", not open, not overdue.
    expect(await list('cancelled')).toContain(number);
    expect(await list('all')).toContain(number);
    expect(await list('open')).not.toContain(number);
    // Once only, and nothing more is done on it.
    expect((await cancel('qa2', id)).statusCode).toBe(409);
    expect((await call(t.app, c.qa2!, 'POST', `/api/deviations/${id}/classify`, { classification: 'minor', typeId, impact: 'x', investigatorId: ids.us2, productBatchChecked: true })).statusCode).toBe(409);
    expect((await call(t.app, c.us1!, 'POST', `/api/deviations/${id}/correct`, { kind: 'report', data: report(), reason: 'x' })).statusCode).toBe(409);
    // The PDF prints it.
    const pdf = await call(t.app, c.qa1!, 'GET', `/api/deviations/${id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    // The integrity check accepts the signature.
    const integrity = await call(t.app, c.admin1!, 'POST', '/api/integrity/run');
    expect(integrity.json().problems).toEqual([]);
  });

  it('the reporter cannot cancel their own report; a classified one (investigation not signed) can be cancelled by another QA', async () => {
    const res = await call(t.app, c.qa1!, 'POST', '/api/deviations', report());
    const { id } = res.json() as { id: number };
    expect((await cancel('qa1', id)).statusCode).toBe(403);
    expect((await call(t.app, c.qa2!, 'POST', `/api/deviations/${id}/classify`, { classification: 'minor', typeId, impact: 'None.', investigatorId: ids.us2, productBatchChecked: true })).statusCode).toBe(200);
    expect((await get(id)).step).toBe('investigation');
    expect((await cancel('qa2', id)).statusCode).toBe(200);
    expect((await get(id)).sections.find((x: { kind: string }) => x.kind === 'cancellation').data.stepBefore).toBe('investigation');
  });

  it('a signature needs deviations.report.cancel at core', async () => {
    const { id } = await file();
    const p = directory.get('qa2')!;
    const before = p.permissions;
    p.permissions = before.filter((x) => x !== 'deviations.report.cancel');
    try {
      expect((await call(t.app, c.qa2!, 'POST', `/api/deviations/${id}/cancel`, { reason: 'Not a deviation.', signature: { proof: proofFor('qa2') } })).statusCode).toBe(401);
    } finally {
      p.permissions = before;
    }
    expect((await get(id)).step).toBe('classification');
  });

  it('not once a CAPA was raised here', async () => {
    const { id } = await file();
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, { classification: 'minor', typeId, impact: 'None.', investigatorId: ids.us2, productBatchChecked: true });
    const capa = await call(t.app, c.qa1!, 'POST', '/api/capas', { source: 'deviation', deviationId: id, type: 'corrective', strength: 'weak', description: 'Retrain.', ownerId: ids.us2, dueDate: '2099-01-01' });
    expect(capa.statusCode, capa.body).toBe(201);
    expect((await cancel('qa2', id)).statusCode).toBe(409);
  });

  it('deviation_v1 says cancelled (closed_at null); trends do not count it; an overdue target date is not overdue', async () => {
    const { id, number } = await file({ title: 'Trend check report' });
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, { classification: 'minor', typeId, impact: 'None.', investigatorId: ids.us2, productBatchChecked: true });
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/target-date`, { targetDate: new Date().toISOString().slice(0, 10), reason: 'x' });
    const month = new Date().toISOString().slice(0, 7);
    const trend = async () => ((await call(t.app, c.qa1!, 'GET', `/api/trends?from=${month}&to=${month}&product=Cancel%20Tablets`)).json().counts as { n: number }[]).reduce((a, r) => a + r.n, 0);
    const before = await trend();
    expect((await cancel('qa2', id)).statusCode).toBe(200);
    expect(await trend()).toBe(before - 1);
    expect(await list('overdue')).not.toContain(number);
    const [row] = await t.owner.unsafe(`select status, closed_at from ${schema}_report.deviation_v1 where number = $1`, [number]);
    expect(row).toEqual({ status: 'cancelled', closed_at: null });
    const lookup = (await call(t.app, c.qa1!, 'GET', '/api/batch-lookup?batch=CT-001')).json() as { number: string; open: boolean }[];
    expect(lookup.find((x) => x.number === number)?.open).toBe(false);
  });

  it('an automatic report cancelled here keeps its source_ref and is never filed again', async () => {
    await t.owner.unsafe(`insert into ${lb}.overdue_v1 (event_id, equipment_code, kind, due_at, detected_at, title, description, immediate_action, impact_notes, decision, sent_at)
      values (41, 'CMP-01', 'pm', now() - interval '2 hours', now(), 'Preventive maintenance overdue: CMP-01', 'Raised by the Logbook.', 'Use blocked.', 'QA to assess.', 'sent', now())`);
    const first = await fileLogbookOverdue(t.sql, { sql: reader, schema: lb });
    expect(first.filed).toHaveLength(1);
    const [d] = await t.owner<{ id: number }[]>`select id::int from deviations where number = ${first.filed[0]!}`;
    expect((await cancel('qa1', d!.id, 'The maintenance was done on time; the Logbook entry was late.')).statusCode).toBe(200);
    expect(await fileLogbookOverdue(t.sql, { sql: reader, schema: lb })).toEqual({ filed: [], problems: [] });
    const [row] = await t.owner.unsafe(`select status, source_ref from ${schema}_report.deviation_v1 where number = $1`, [first.filed[0]!]);
    expect(row).toEqual({ status: 'cancelled', source_ref: 'logbook:overdue:41' });
  });
});
