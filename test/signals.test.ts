import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

// S8 (D-27): rule-based hints on a deviation. Each test uses its own area, so tests do not see each other's data.
let t: TestApp;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};
let typeId: number;
let otherTypeId: number;

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin1', ['admin']], ['qa1', ['qa', 'user']], ['us1', ['user']], ['us2', ['user']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  typeId = (await call(t.app, c.admin1!, 'POST', '/api/deviation-types', { name: 'Equipment' })).json().id;
  otherTypeId = (await call(t.app, c.admin1!, 'POST', '/api/deviation-types', { name: 'Documentation' })).json().id;
});
afterAll(() => t.close());

let n = 0;
const newArea = async () => (await call(t.app, c.admin1!, 'POST', '/api/areas', { name: `Area ${++n}` })).json().id as number;
async function report(areaId: number, over: object = {}) {
  const r = await call(t.app, c.us1!, 'POST', '/api/deviations', {
    planned: false, title: 'Tablet weight out of limit', description: 'IPC weight high on press.', areaId, equipment: '',
    eventAt: new Date(Date.now() - 600_000).toISOString(), products: [{ product: `Product ${n}`, batch: `B-${n}-${Math.random().toString(36).slice(2, 7)}` }],
    initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'Press stopped.', ...over,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as number;
}
const classify = (id: number, type = typeId) =>
  call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, { classification: 'minor', typeId: type, impact: 'This batch.', investigatorId: ids.us2, productBatchChecked: true });
const investigate = (id: number, over: object = {}) =>
  call(t.app, c.us2!, 'POST', `/api/deviations/${id}/investigate`, {
    data: { rootCause: 'Feeder speed not reset after maintenance.', otherBatches: [], noOtherReason: 'Single batch on the press.', conclusion: 'Only this batch.', ...over },
    signature: { username: 'us2', password: PASSWORD },
  });
const signals = async (id: number) => {
  const r = await call(t.app, c.us1!, 'GET', `/api/deviations/${id}/signals`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { flags: { kind: string; text: string; deviations: { number: string }[] }[]; similar: { number: string; rootCause: string; why: string[]; causes: { category: string; text: string }[]; capas: { number: string }[] }[] };
};
const kinds = async (id: number) => (await signals(id)).flags.map((f) => f.kind);

describe('investigation hints (S8)', () => {
  it('S8: a batch named in another deviation is flagged, whatever the spelling', async () => {
    const a = await newArea();
    await report(a, { products: [{ product: 'Metformin', batch: 'MET-24/001' }] });
    const id = await report(await newArea(), { products: [{ product: 'Metformin', batch: 'met 24 001' }] });
    const f = (await signals(id)).flags.find((x) => x.kind === 'batch');
    expect(f?.text).toMatch(/also named in 1 other deviation/);
  });

  it('S8: placeholder batches such as "N/A" or "none" never count as the same batch', async () => {
    await report(await newArea(), { products: [{ product: 'Facility', batch: 'N/A' }] });
    const id = await report(await newArea(), { products: [{ product: 'Utilities', batch: 'n.a.' }] });
    expect(await kinds(id)).not.toContain('batch');
  });

  it('S8: the same equipment is flagged once; the same area only from two other deviations', async () => {
    const a = await newArea();
    await report(a, { equipment: 'Comp-01' });
    const second = await report(a, { equipment: 'comp 01' });
    expect(await kinds(second)).toContain('equipment');
    expect(await kinds(second)).not.toContain('area');
    const third = await report(a);
    expect(await kinds(third)).toContain('area');
  });

  it('S8: human error named twice in the area is flagged; a late report is flagged', async () => {
    const a = await newArea();
    for (let i = 0; i < 2; i++) {
      const id = await report(a);
      await classify(id);
      expect((await investigate(id, { humanError: true, humanErrorJustification: 'Operator skipped step 4.' })).statusCode).toBe(200);
    }
    const late = await report(a, { eventAt: new Date(Date.now() - 5 * 86_400_000).toISOString() });
    const k = await kinds(late);
    expect(k).toContain('human_error');
    expect(k).toContain('late_report');
    expect(await kinds(await report(await newArea()))).not.toContain('late_report');
  });

  it('S8: similar earlier cases show their root cause, fishbone causes and CAPAs; unrelated ones do not', async () => {
    const a = await newArea();
    const old = await report(a, { equipment: 'Press 7', title: 'Weight variation on press 7' });
    await classify(old);
    await investigate(old, { fishbone: { man: '', machine: 'Feeder worn', method: '', material: '', measurement: '', environment: '' } });
    const capa = await call(t.app, c.qa1!, 'POST', '/api/capas', { source: 'deviation', deviationId: old, type: 'corrective', description: 'Replace feeder', ownerId: ids.us2, dueDate: '2030-01-01' });
    expect(capa.statusCode, capa.body).toBe(201);
    const unrelated = await report(await newArea(), { title: 'Label torn' });
    await classify(unrelated, otherTypeId);
    await investigate(unrelated);
    const now = await report(a, { equipment: 'PRESS-7', title: 'Weight variation again' });
    await classify(now);
    const s = await signals(now);
    const numbers = s.similar.map((x) => x.number);
    const hit = s.similar[0]!;
    expect(hit.rootCause).toMatch(/Feeder speed/);
    expect(hit.why).toEqual(expect.arrayContaining(['same type', 'same equipment']));
    expect(hit.causes).toEqual([{ category: 'Machine / equipment', text: 'Feeder worn' }]);
    expect(hit.capas).toHaveLength(1);
    const unrelatedNumber = (await call(t.app, c.qa1!, 'GET', `/api/deviations/${unrelated}`)).json().number;
    expect(numbers).not.toContain(unrelatedNumber);
  });

  it('S8: hints are for User and QA only; an unknown deviation is not found', async () => {
    const id = await report(await newArea());
    expect((await call(t.app, c.admin1!, 'GET', `/api/deviations/${id}/signals`)).statusCode).toBe(403);
    expect((await call(t.app, c.us1!, 'GET', '/api/deviations/999999/signals')).statusCode).toBe(404);
  });
});
