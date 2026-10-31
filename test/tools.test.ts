import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';
import { FAULT_TREE, KT, TOOLS } from './fixtures.js';

// S14 (D-33, D-36): barrier analysis, FMEA, KT for lab / OOS types, fault tree when critical, CAPA strength,
// weak CAPAs on a critical deviation, and the Pareto of root causes.
let t: TestApp;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};
let areaId: number;
let typeId: number;
let labTypeId: number;

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin1', ['admin']], ['qa1', ['qa', 'user']], ['us1', ['user']], ['us2', ['user']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  areaId = (await call(t.app, c.admin1!, 'POST', '/api/areas', { name: 'QC lab' })).json().id;
  typeId = (await call(t.app, c.admin1!, 'POST', '/api/deviation-types', { name: 'Equipment' })).json().id;
  labTypeId = (await call(t.app, c.admin1!, 'POST', '/api/deviation-types', { name: 'OOS result' })).json().id;
});
afterAll(() => t.close());

const sig = (u: string) => ({ username: u, password: PASSWORD });
async function classified(classification = 'major', type = typeId) {
  const r = await call(t.app, c.us1!, 'POST', '/api/deviations', {
    planned: false, title: 'Hardness low', description: 'Hardness 2 kg/cm².', areaId, eventAt: new Date(Date.now() - 600_000).toISOString(),
    products: [{ product: 'PCM500', batch: `B-${Math.random().toString(36).slice(2, 7)}` }], immediateAction: 'Stopped.',
    initialImpact: { productQuality: 'yes', patientSafety: 'unknown', otherBatches: 'unknown', notes: 'On hold.' },
  });
  const id = r.json().id as number;
  await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, { classification, typeId: type, impact: 'This batch.', investigatorId: ids.us2, productBatchChecked: true });
  return id;
}
const investigation = (over: Record<string, unknown> = {}) => ({
  ...TOOLS, rootCause: 'Drying time cut to 20 min.', otherBatches: [], noOtherReason: 'Only batch dried that day.', conclusion: 'Batch rejected.', ...over,
});
const investigate = (id: number, data: object = investigation()) =>
  call(t.app, c.us2!, 'POST', `/api/deviations/${id}/investigate`, { data, signature: sig('us2') });
const raise = (id: number, strength?: string) =>
  call(t.app, c.qa1!, 'POST', '/api/capas', { source: 'deviation', deviationId: id, type: 'corrective', description: 'Fix it', ownerId: ids.us2, dueDate: '2030-01-01', ...(strength ? { strength } : {}) });
const close = (id: number, data: object) => call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/close`, { data: { summary: 'Reviewed.', ...data }, signature: sig('qa1') });

describe('investigation tools II (S14)', () => {
  it('S14: barrier analysis and FMEA are required, with named problems', async () => {
    const id = await classified();
    const problems = async (over: Record<string, unknown>) => (await investigate(id, investigation(over))).json().problems as string[];
    expect(await problems({ barriers: [] })).toContain('Barrier analysis: list at least one barrier that should have prevented it.');
    expect(await problems({ barriers: [{ barrier: 'Self-check', worked: 'no', whyFailed: '' }] })).toContain('Barrier analysis: say why each failed or missing barrier did not stop it.');
    expect(await problems({ fmea: { ...TOOLS.fmea, severity: 11 } })).toContain('FMEA: severity (1 to 10).');
    expect(await problems({ fmea: { ...TOOLS.fmea, patientRisk: '' } })).toContain('FMEA: risk to the patient if the CAPA is not done: required.');
    expect((await investigate(id)).statusCode).toBe(200);
  });

  it('S14: a lab / OOS type needs the KT checklist (Phase 1B when no lab cause); Admin marks the type, with a reason, audited', async () => {
    expect((await call(t.app, c.qa1!, 'PATCH', `/api/deviation-types/${labTypeId}/lab`, { labOos: true, reason: 'CC-1' })).statusCode).toBe(403);
    expect((await call(t.app, c.admin1!, 'PATCH', `/api/deviation-types/${labTypeId}/lab`, { labOos: true, reason: 'CC-1' })).json()).toEqual({ id: labTypeId, labOos: true });
    const types = (await call(t.app, c.us1!, 'GET', '/api/deviation-types')).json() as { id: number; labOos: boolean }[];
    expect(types.find((x) => x.id === labTypeId)!.labOos).toBe(true);
    const [a] = await t.owner`select reason from audit_log where action = 'deviation_type.lab_changed'`;
    expect(a!.reason).toBe('CC-1');
    const id = await classified('major', labTypeId);
    expect((await call(t.app, c.us2!, 'GET', `/api/deviations/${id}`)).json().labOos).toBe(true);
    expect((await investigate(id)).json().problems).toContain('KT: required for a lab / OOS deviation.');
    expect((await investigate(id, investigation({ kt: { ...KT, phase1b: { manufacturingReview: '', retestPlan: '' } } }))).json().problems)
      .toContain('KT 1B: no lab cause was found, so write the manufacturing review and the retest plan.');
    expect((await investigate(id, investigation({ kt: KT }))).statusCode).toBe(200);
  });

  it('S14: a critical deviation needs a fault tree with at least 2 branches tested with evidence', async () => {
    const id = await classified('critical');
    expect((await investigate(id)).json().problems).toContain('Fault tree: required for a critical deviation.');
    expect((await investigate(id, investigation({ faultTree: { ...FAULT_TREE, branches: FAULT_TREE.branches.slice(0, 1) } }))).json().problems)
      .toContain('Fault tree: at least 2 branches, each tested with evidence.');
    expect((await investigate(id, investigation({ faultTree: { ...FAULT_TREE, branches: [...FAULT_TREE.branches, { ...FAULT_TREE.branches[0], id: 'b3', parent: 'b9' }] } }))).json().problems)
      .toContain('Fault tree: each branch hangs from the top event or another branch.');
    // The check before signing lists the same.
    expect((await call(t.app, c.us2!, 'POST', `/api/deviations/${id}/investigation/check`, { data: investigation() })).json().problems).toContain('Fault tree: required for a critical deviation.');
    expect((await investigate(id, investigation({ faultTree: FAULT_TREE }))).statusCode).toBe(200);
  });

  it('S14: every CAPA has a strength; a critical deviation with only weak CAPAs closes only with QA\'s reason', async () => {
    const id = await classified('critical');
    await investigate(id, investigation({ faultTree: FAULT_TREE }));
    expect((await raise(id)).statusCode).toBe(400);
    expect((await raise(id, 'weak')).statusCode).toBe(201);
    const list = (await call(t.app, c.qa1!, 'GET', `/api/capas?deviationId=${id}&status=all`)).json();
    expect(list[0].strength).toBe('weak');
    const blocked = await close(id, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().problems[0]).toMatch(/strong or medium CAPA/);
    expect((await close(id, { weakCapaJustification: 'Interlock impossible on this old press; replacement ordered under CC-9.' })).statusCode).toBe(200);
    const d = (await call(t.app, c.qa1!, 'GET', `/api/deviations/${id}`)).json();
    expect(d.sections.find((s: { kind: string }) => s.kind === 'closure').data.weakCapaJustification).toMatch(/Interlock impossible/);
    // With a medium CAPA no reason is needed.
    const other = await classified('critical');
    await investigate(other, investigation({ faultTree: FAULT_TREE }));
    await raise(other, 'weak');
    await raise(other, 'medium');
    expect((await close(other, {})).statusCode).toBe(200);
  });

  it('S14: the trend shows a Pareto of root-cause categories and flags a category repeated 3 times in 6 months', async () => {
    for (let i = 0; i < 3; i++) await investigate(await classified(), investigation({ rootCauseCategory: 'human' }));
    const month = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
    const r = (await call(t.app, c.qa1!, 'GET', `/api/trends?from=${month}&to=${month}`)).json();
    expect(r.pareto[0]).toMatchObject({ category: 'equipment' });
    expect(r.pareto).toEqual(expect.arrayContaining([{ category: 'human', n: 3 }]));
    expect(r.repeats).toEqual(expect.arrayContaining([{ category: 'human', n: 3 }]));
  });
});
