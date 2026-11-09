import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshApp, login, seedUser, sig, type TestApp } from './helpers.js';
import { TOOLS } from './fixtures.js';

// D-49: report.deviation_v1 for Batchwright's release check: read-only, one row per batch the deviation names.
let t: TestApp;
let schema: string;
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
  areaId = (await call(t.app, c.admin1!, 'POST', '/api/areas', { name: 'Granulation' })).json().id;
  typeId = (await call(t.app, c.admin1!, 'POST', '/api/deviation-types', { name: 'Process' })).json().id;
});
afterAll(() => t.close());

const report = (products: { product: string; batch: string }[]) => ({
  planned: false, title: 'Granule LOD high', description: 'LOD 3.1 % against NMT 2.5 %.', areaId,
  eventAt: new Date(Date.now() - 600_000).toISOString(), products,
  initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'Granules held.',
});
const view = (number: string) => t.owner.unsafe(
  `select number, status, classification, product, batch, batch_norm, outcome, opened_at, closed_at, read_at, data_as_of
   from ${schema}_report.deviation_v1 where number = $1 order by batch nulls first`, [number]);
const FINAL = { finalImpact: { productQuality: 'no', patientSafety: 'no', otherBatches: 'no', notes: 'Granules re-dried and passed.' } };

describe('deviation report view (D-49)', () => {
  it('DV-11: report.deviation_v1 gives each batch the deviation names, with status and classification, until closure', async () => {
    const r = await call(t.app, c.us1!, 'POST', '/api/deviations', report([{ product: 'Paracetamol 500', batch: 'PCM-24/07' }]));
    expect(r.statusCode, r.body).toBe(201);
    const { id, number } = r.json() as { id: number; number: string };
    const opened = await view(number);
    expect(opened).toEqual([expect.objectContaining({ number, status: 'classification', classification: null, product: 'Paracetamol 500', batch: 'PCM-24/07', batch_norm: 'pcm2407', outcome: null, closed_at: null })]);
    expect(opened[0]!.read_at.getTime()).toBeGreaterThanOrEqual(opened[0]!.data_as_of.getTime());

    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, { classification: 'minor', typeId, impact: 'PCM-24/07 only.', investigatorId: ids.us2, productBatchChecked: true });
    const inv = await call(t.app, c.us2!, 'POST', `/api/deviations/${id}/investigate`, {
      data: { ...TOOLS, rootCause: 'Dryer inlet probe drifted.', otherBatches: [{ product: 'Paracetamol 500', batch: 'PCM-24/06', outcome: 'not_affected' }], conclusion: 'Re-dry PCM-24/07.' },
      signature: sig('us2'),
    });
    expect(inv.statusCode, inv.body).toBe(200);
    expect((await view(number)).map((x) => [x.status, x.classification, x.batch, x.outcome])).toEqual([
      ['closure', 'minor', 'PCM-24/06', 'not_affected'],
      ['closure', 'minor', 'PCM-24/07', null],
    ]);

    const close = (user: string) => call(t.app, c[user]!, 'POST', `/api/deviations/${id}/close`,
      { data: { ...FINAL, summary: 'Re-dried.', noCapaReason: 'Probe recalibrated; immediate action enough.' }, signature: sig(user) });
    expect((await close('qa1')).statusCode).toBe(200);
    const closed = await view(number);
    const [g] = await t.owner<{ at: Date }[]>`select max(signed_at) as at from signatures where meaning = 'closed'`;
    expect(closed.map((x) => [x.status, x.closed_at])).toEqual([['closed', g!.at], ['closed', g!.at]]);
    expect(closed[0]!.data_as_of).toEqual(g!.at);

    // A reopened deviation is not closed: no closed_at until it is closed again.
    const ro = await call(t.app, c.qa2!, 'POST', `/api/deviations/${id}/reopen`, { reason: 'Stability result on PCM-24/07', signature: sig('qa2') });
    expect(ro.statusCode, ro.body).toBe(200);
    expect((await view(number)).map((x) => [x.status, x.closed_at])).toEqual([['closure', null], ['closure', null]]);
    expect((await close('qa2')).statusCode).toBe(200);
    expect((await view(number)).every((x) => x.status === 'closed' && x.closed_at !== null)).toBe(true);
  });

  it('DV-11: a deviation that names no batch is still found by its number, with the batch columns empty', async () => {
    const r = await call(t.app, c.us1!, 'POST', '/api/deviations', { ...report([]), noBatch: true });
    expect(r.statusCode, r.body).toBe(201);
    expect(await view(r.json().number)).toEqual([expect.objectContaining({ status: 'classification', product: null, batch: null, batch_norm: null, outcome: null })]);
  });

  it('DV-15: deviation_report reads the view only: no table, no write, no temporary objects', async () => {
    const asReport = (q: string) => t.owner.begin(async (tx) => {
      await tx.unsafe('set local role deviation_report');
      return (await tx.unsafe(q)) as unknown;
    }).then((r) => ({ ok: true as const, r }), (e: Error) => ({ ok: false as const, error: e.message }));
    const read = await asReport(`select count(*)::int as n from ${schema}_report.deviation_v1`);
    expect(read.ok && (read.r as { n: number }[])[0]!.n).toBeGreaterThan(0);
    for (const q of [`select * from ${schema}.deviations`, `select * from ${schema}.batches`, `select * from ${schema}_report.capa_v1`,
      `delete from ${schema}_report.deviation_v1`, 'create temporary table x (a int)']) {
      const r = await asReport(q);
      expect(r.ok, q).toBe(false);
      expect(!r.ok && r.error, q).toMatch(/permission denied|cannot delete/);
    }
  });
});
