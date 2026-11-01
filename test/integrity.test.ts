import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIntegrityCheck } from '../server/integrity.js';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';
import { TOOLS } from './fixtures.js';

let t: TestApp;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};
let dev: number;
let capa: number;
const sig = (u: string) => ({ username: u, password: PASSWORD });

// One deviation taken through every signed step (planned, approved, corrected, re-approved, investigated, closed)
// and one CAPA through verification, so the check sees every kind of signature.
beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin1', ['admin']], ['qa1', ['qa', 'user']], ['qa2', ['qa', 'user']], ['us1', ['user']], ['us2', ['user']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  const areaId = (await call(t.app, c.admin1!, 'POST', '/api/areas', { name: 'Sterile filling' })).json().id;
  const typeId = (await call(t.app, c.admin1!, 'POST', '/api/deviation-types', { name: 'Process' })).json().id;
  const report = (reason: string) => ({
    planned: true, plannedReason: reason, title: 'Hold time extension', description: 'x', areaId,
    eventAt: new Date(Date.now() - 60_000).toISOString(), products: [{ product: 'Ondansetron inj', batch: 'OND-5' }], initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'x',
  });
  dev = (await call(t.app, c.us1!, 'POST', '/api/deviations', report('Filter delivery late'))).json().id;
  await call(t.app, c.qa1!, 'POST', `/api/deviations/${dev}/classify`, { classification: 'minor', typeId, impact: 'x', investigatorId: ids.us2, productBatchChecked: true });
  const approve = async () => {
    const hash = (await call(t.app, c.qa1!, 'GET', `/api/deviations/${dev}`)).json().approvalHash;
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${dev}/approve`, { ...sig('qa1'), contentHash: hash });
  };
  await approve();
  await call(t.app, c.us1!, 'POST', `/api/deviations/${dev}/correct`, { kind: 'report', data: report('Filter delivery late (vendor)'), reason: 'clarified' });
  await approve();
  await call(t.app, c.us2!, 'POST', `/api/deviations/${dev}/investigate`, { data: { ...TOOLS, rootCause: 'x', otherBatches: [], noOtherReason: 'x', conclusion: 'x' }, signature: sig('us2') });
  await call(t.app, c.us1!, 'POST', `/api/deviations/${dev}/attachments`, { filename: 'a.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 a').toString('base64') });
  const close = await call(t.app, c.qa2!, 'POST', `/api/deviations/${dev}/close`, { data: { summary: 'ok', noCapaReason: 'Immediate action enough.', finalImpact: { productQuality: 'no', patientSafety: 'no', otherBatches: 'no', notes: 'Only the segregated material was affected.' } }, signature: sig('qa2') });
  expect(close.statusCode, close.body).toBe(200);
  const due = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  capa = (await call(t.app, c.qa1!, 'POST', '/api/capas', { source: 'other', sourceRef: 'x', type: 'corrective', strength: 'medium', description: 'x', ownerId: ids.us1, dueDate: due })).json().id;
  await call(t.app, c.us1!, 'POST', `/api/capas/${capa}/done`, { note: 'done' });
  const k = (await call(t.app, c.qa1!, 'GET', `/api/capas/${capa}`)).json();
  await call(t.app, c.qa1!, 'POST', `/api/capas/${capa}/verify`, { effectiveness: { mode: 'trend', reason: 'low risk' }, versionId: k.versions.at(-1).id, signature: sig('qa1') });
});
afterAll(() => t.close());

describe('integrity check', () => {
  it('DV-22: passes on untouched records and writes its result to the audit trail', async () => {
    const r = await runIntegrityCheck(t.sql);
    expect(r.problems).toEqual([]);
    expect(r.signatures).toBe(5);
    const [row] = await t.owner`select action from audit_log where object_type = 'system' order by id desc limit 1`;
    expect(row!.action).toBe('integrity.passed');
  });

  it('DV-22: finds a section changed behind the application\'s back', async () => {
    const [s] = await t.owner<{ id: number; data: Record<string, string> }[]>`select id::int, data from sections where deviation_id = ${dev} and kind = 'investigation'`;
    await t.owner`update sections set data = ${t.owner.json({ ...s!.data, conclusion: 'tampered' })} where id = ${s!.id}`;
    const r = await runIntegrityCheck(t.sql);
    expect(r.problems.some((p) => p.includes('content changed after signing'))).toBe(true);
    await t.owner`update sections set data = ${t.owner.json(s!.data)} where id = ${s!.id}`;
  });

  it('DV-22: finds a tampered attachment and a CAPA version changed after signing', async () => {
    await t.owner`update attachments set data = 'x'::bytea where deviation_id = ${dev}`;
    await t.owner`update capa_versions set data = data || '{"description":"tampered"}' where capa_id = ${capa} and action = 'verified'`;
    const r = await runIntegrityCheck(t.sql);
    expect(r.problems.some((p) => p.startsWith('Attachment'))).toBe(true);
    expect(r.problems.some((p) => p.includes('on capa'))).toBe(true);
    const [row] = await t.owner`select action from audit_log where object_type = 'system' order by id desc limit 1`;
    expect(row!.action).toBe('integrity.failed');
  });

  it('DV-22: finds a deleted signature and a rewritten hash through the audit trail, and raises an alert', async () => {
    const [g] = await t.owner<{ id: number }[]>`select id::int from signatures where meaning = 'closed' and object_type = 'section'`;
    await t.owner`update signatures set content_hash = ${'0'.repeat(64)} where meaning = 'investigation_complete'`;
    await t.owner`delete from signatures where id = ${g!.id}`;
    const r = await runIntegrityCheck(t.sql);
    expect(r.problems.some((p) => p.includes('in the audit trail but missing'))).toBe(true);
    expect(r.problems.some((p) => p.includes('differs from the one in the audit trail'))).toBe(true);
    expect(r.problems.some((p) => p.includes('closed without a signed closure'))).toBe(true);
    const [alert] = await t.owner`select kind from alerts order by id desc limit 1`;
    expect(alert!.kind).toBe('integrity_failed');
  });

  it('DV-22: QA and Admin can run the check and see the last result; plain users cannot', async () => {
    expect((await call(t.app, c.us1!, 'POST', '/api/integrity/run', {})).statusCode).toBe(403);
    expect((await call(t.app, c.admin1!, 'POST', '/api/integrity/run', {})).statusCode).toBe(200);
    const last = (await call(t.app, c.qa1!, 'GET', '/api/integrity')).json();
    expect(last.action).toMatch(/^integrity\./);
  });

  it('DV-22: the application has no delete path for any record table', async () => {
    for (const table of ['deviations', 'sections', 'batches', 'signatures', 'attachments', 'attachment_withdrawals', 'capas', 'capa_versions', 'audit_log']) {
      await expect(t.sql.unsafe(`delete from ${table}`)).rejects.toThrow(/permission denied/);
    }
  });
});
