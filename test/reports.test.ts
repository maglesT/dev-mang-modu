import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

let t: TestApp;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};
let areas: Record<string, number>;
let typeId: number;
const sig = (u: string) => ({ username: u, password: PASSWORD });
const thisMonth = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
const inDays = (n: number) => new Date(Date.now() + n * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin1', ['admin']], ['qa1', ['qa', 'user']], ['us1', ['user']], ['us2', ['user']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  areas = {};
  for (const a of ['Granulation', 'Packing']) areas[a] = (await call(t.app, c.admin1!, 'POST', '/api/areas', { name: a })).json().id;
  typeId = (await call(t.app, c.admin1!, 'POST', '/api/deviation-types', { name: 'Process' })).json().id;
});
afterAll(() => t.close());

async function report(area: string, product: string, batch: string) {
  return (await call(t.app, c.us1!, 'POST', '/api/deviations', {
    planned: false, title: `Issue on ${batch}`, description: 'x', areaId: areas[area], eventAt: new Date(Date.now() - 60_000).toISOString(),
    products: [{ product, batch }], initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'x',
  })).json() as { id: number; number: string };
}
const classify = (id: number, classification = 'major') =>
  call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, { classification, typeId, impact: 'x', investigatorId: ids.us2, productBatchChecked: true });

describe('batch lookup', () => {
  it('DV-11: finds deviations naming a batch as their own or as an other batch checked, open ones first', async () => {
    const own = await report('Granulation', 'Paracetamol 500', 'LK-100');
    const viaOther = await report('Packing', 'Ibuprofen 400', 'IB-1');
    await classify(viaOther.id);
    await call(t.app, c.us2!, 'POST', `/api/deviations/${viaOther.id}/investigate`, {
      data: { rootCause: 'x', otherBatches: [{ product: 'Paracetamol 500', batch: 'lk 100', outcome: 'not_affected' }], conclusion: 'x' },
      signature: sig('us2'),
    });
    const rows = (await call(t.app, c.us2!, 'GET', '/api/batch-lookup?batch=LK-100')).json() as { number: string; role: string; open: boolean }[];
    expect(rows.map((r) => [r.number, r.role, r.open]).sort()).toEqual([[own.number, 'own', true], [viaOther.number, 'other', true]].sort());
    expect((await call(t.app, c.us2!, 'GET', '/api/batch-lookup?batch=--')).statusCode).toBe(400);
  });
});

describe('trends', () => {
  it('DV-12: counts by month split by area, type or classification', async () => {
    await report('Granulation', 'Metformin 500', 'TR-1');
    const b = await report('Packing', 'Metformin 500', 'TR-2');
    await classify(b.id, 'critical');
    const byArea = (await call(t.app, c.qa1!, 'GET', `/api/trends?from=${thisMonth}&to=${thisMonth}&by=area`)).json();
    const packing = byArea.counts.find((r: { key: string }) => r.key === 'Packing');
    expect(packing).toMatchObject({ month: thisMonth });
    expect(packing.n).toBeGreaterThanOrEqual(1);
    const byClass = (await call(t.app, c.qa1!, 'GET', `/api/trends?from=${thisMonth}&to=${thisMonth}&by=classification`)).json();
    expect(byClass.counts.map((r: { key: string }) => r.key)).toContain('critical');
  });

  it('DV-12: the product filter lists every spelling it matched', async () => {
    await report('Granulation', 'Atenolol 50 mg', 'AT-1');
    await report('Granulation', 'ATENOLOL 50MG', 'AT-2');
    const res = (await call(t.app, c.qa1!, 'GET', `/api/trends?from=${thisMonth}&to=${thisMonth}&by=area&product=atenolol`)).json();
    expect(res.products.map((p: { product: string }) => p.product).sort()).toEqual(['ATENOLOL 50MG', 'Atenolol 50 mg']);
    expect(res.counts.reduce((s: number, r: { n: number }) => s + r.n, 0)).toBe(2);
  });

  it('DV-12, DV-09: CAPA counts by source, status and effectiveness outcome', async () => {
    const { id } = (await call(t.app, c.qa1!, 'POST', '/api/capas', { source: 'audit', sourceRef: 'IA-1', type: 'preventive', description: 'x', ownerId: ids.us1, dueDate: inDays(5) })).json();
    await call(t.app, c.us1!, 'POST', `/api/capas/${id}/done`, { note: 'done' });
    const k = (await call(t.app, c.qa1!, 'GET', `/api/capas/${id}`)).json();
    await call(t.app, c.qa1!, 'POST', `/api/capas/${id}/verify`, { effectiveness: { mode: 'trend', reason: 'low risk' }, versionId: k.versions.at(-1).id, signature: sig('qa1') });
    const res = (await call(t.app, c.qa1!, 'GET', `/api/trends?from=${thisMonth}&to=${thisMonth}`)).json();
    expect(res.capas).toContainEqual({ source: 'audit', step: 'closed', outcome: 'trend', n: 1 });
  });

  it('a period with "from" after "to" is refused', async () => {
    expect((await call(t.app, c.qa1!, 'GET', '/api/trends?from=2026-05&to=2026-01')).statusCode).toBe(400);
  });
});

describe('PDF copies', () => {
  it('DV-21: a deviation prints as a PDF; a correction is included with its reason', async () => {
    const d = await report('Granulation', 'Paracetamol 500', 'PDF-1');
    await call(t.app, c.us1!, 'POST', `/api/deviations/${d.id}/correct`, {
      kind: 'report', reason: 'Title corrected',
      data: { planned: false, title: 'Corrected title', description: 'x', areaId: areas.Granulation, eventAt: new Date(Date.now() - 60_000).toISOString(), products: [{ product: 'Paracetamol 500', batch: 'PDF-1' }], initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'x' },
    });
    const res = await t.app.inject({ method: 'GET', url: `/api/deviations/${d.id}/pdf`, headers: { cookie: c.us2! } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(2000);
  });

  it('DV-21: a CAPA prints as a PDF; unknown ids give 404', async () => {
    const { id } = (await call(t.app, c.qa1!, 'POST', '/api/capas', { source: 'other', sourceRef: 'X', type: 'corrective', description: 'x', ownerId: ids.us1, dueDate: inDays(5) })).json();
    const res = await t.app.inject({ method: 'GET', url: `/api/capas/${id}/pdf`, headers: { cookie: c.us1! } });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await t.app.inject({ method: 'GET', url: '/api/capas/999999/pdf', headers: { cookie: c.us1! } })).statusCode).toBe(404);
  });
});

describe('review fixes (S5)', () => {
  it('DV-12: a period over 120 months is refused', async () => {
    expect((await call(t.app, c.qa1!, 'GET', '/api/trends?from=2000-01&to=2026-12')).statusCode).toBe(400);
  });

  it('DV-12: with a product filter, a CAPA raised now for a deviation reported earlier is still counted', async () => {
    const d = await report('Granulation', 'Lisinopril 10', 'LS-1');
    await t.owner`update deviations set reported_at = now() - interval '200 days' where id = ${d.id}`;
    await classify(d.id);
    await call(t.app, c.qa1!, 'POST', '/api/capas', { source: 'deviation', deviationId: d.id, type: 'corrective', description: 'x', ownerId: ids.us1, dueDate: inDays(5) });
    const res = (await call(t.app, c.qa1!, 'GET', `/api/trends?from=${thisMonth}&to=${thisMonth}&product=lisinopril`)).json();
    expect(res.capas.reduce((s: number, x: { n: number }) => s + x.n, 0)).toBe(1);
  });
});
