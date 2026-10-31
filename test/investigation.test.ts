import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

let t: TestApp;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};
let areaId: number;
let typeId: number;

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin1', ['admin']], ['qa1', ['qa', 'user']], ['qa2', ['qa', 'user']], ['us1', ['user']], ['us2', ['user']], ['us3', ['user']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  areaId = (await call(t.app, c.admin1!, 'POST', '/api/areas', { name: 'Compression' })).json().id;
  typeId = (await call(t.app, c.admin1!, 'POST', '/api/deviation-types', { name: 'Equipment' })).json().id;
});
afterAll(() => t.close());

const report = (over: object = {}) => ({
  planned: false, title: 'Punch damage found', description: 'Upper punch 7 chipped at line clearance.', areaId,
  eventAt: new Date(Date.now() - 600_000).toISOString(), products: [{ product: 'Metformin 500', batch: 'MET-11' }],
  immediateAction: 'Tablets since last IPC segregated.', ...over,
});
const investigation = (over: object = {}) => ({
  rootCause: 'Punch used beyond its life; counter not reset after tooling change.',
  mostLikely: false, humanError: false,
  otherBatches: [{ product: 'Metformin 500', batch: 'MET-10', outcome: 'not_affected' }],
  conclusion: 'No impact on MET-10; MET-11 segregated tablets rejected.',
  ...over,
});
const sig = (u: string, password = PASSWORD) => ({ username: u, password });

// A deviation reported by us1, classified by qa1, with us2 as investigator.
async function inInvestigation(planned = false) {
  const r = await call(t.app, c.us1!, 'POST', '/api/deviations', report(planned ? { planned: true, plannedReason: 'Trial' } : {}));
  const id = r.json().id as number;
  await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, { classification: 'major', typeId, impact: 'Batch MET-11 only.', investigatorId: ids.us2, productBatchChecked: true });
  if (planned) {
    const hash = (await call(t.app, c.qa1!, 'GET', `/api/deviations/${id}`)).json().approvalHash;
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/approve`, { ...sig('qa1'), contentHash: hash });
  }
  return id;
}
const get = async (id: number) => (await call(t.app, c.qa1!, 'GET', `/api/deviations/${id}`)).json();
const investigate = (id: number, user = 'us2', data: object = investigation()) =>
  call(t.app, c[user]!, 'POST', `/api/deviations/${id}/investigate`, { data, signature: sig(user) });

describe('investigation', () => {
  it('DV-07: the investigator signs the investigation with root cause and conclusion; the deviation waits for closure', async () => {
    const id = await inInvestigation();
    const res = await investigate(id);
    expect(res.statusCode, res.body).toBe(200);
    const d = await get(id);
    expect(d.step).toBe('closure');
    expect(d.signatures.map((s: { meaning: string; printedName: string }) => [s.meaning, s.printedName])).toEqual([['investigation_complete', 'US2']]);
  });

  it('DV-04: root cause and conclusion are required', async () => {
    const id = await inInvestigation();
    expect((await investigate(id, 'us2', investigation({ rootCause: '' }))).statusCode).toBe(400);
    expect((await investigate(id, 'us2', investigation({ conclusion: '' }))).statusCode).toBe(400);
  });

  it('DV-04: "most likely cause" can be recorded when the true cause is not confirmed', async () => {
    const id = await inInvestigation();
    expect((await investigate(id, 'us2', investigation({ mostLikely: true }))).statusCode).toBe(200);
    const s = (await get(id)).sections.find((x: { kind: string }) => x.kind === 'investigation');
    expect(s.data.mostLikely).toBe(true);
  });

  it('DV-05: human error needs a justification', async () => {
    const id = await inInvestigation();
    const res = await investigate(id, 'us2', investigation({ humanError: true }));
    expect(res.statusCode).toBe(400);
    expect(res.json().problems[0]).toMatch(/human error/i);
    expect((await investigate(id, 'us2', investigation({ humanError: true, humanErrorJustification: 'SOP and counter checked; operator skipped step 4.2.' }))).statusCode).toBe(200);
  });

  it('DV-06: other batches are listed with an outcome, or a reason is given why none could be affected', async () => {
    const id = await inInvestigation();
    const none = await investigate(id, 'us2', investigation({ otherBatches: [] }));
    expect(none.statusCode).toBe(400);
    expect((await investigate(id, 'us2', investigation({ otherBatches: [], noOtherReason: 'Punch set used only for MET-11.' }))).statusCode).toBe(200);
  });

  it('DV-11: a batch listed only as an "other batch" is found by the batch search', async () => {
    const id = await inInvestigation();
    await investigate(id, 'us2', investigation({ otherBatches: [{ product: 'Glimepiride 2', batch: 'GLM-500', outcome: 'affected' }] }));
    const found = (await call(t.app, c.us3!, 'GET', '/api/deviations?view=all&q=GLM 500')).json() as { id: number }[];
    expect(found.map((d) => d.id)).toContain(id);
  });

  it('DV-19: only the investigator or QA investigates, and only in the investigation step', async () => {
    const id = await inInvestigation();
    expect((await investigate(id, 'us3')).statusCode).toBe(403);
    const fresh = (await call(t.app, c.us1!, 'POST', '/api/deviations', report())).json().id;
    expect((await investigate(fresh)).statusCode).toBe(409);
  });

  it('DV-17: signing needs the signer\'s own user ID and password', async () => {
    const id = await inInvestigation();
    const res = await call(t.app, c.us2!, 'POST', `/api/deviations/${id}/investigate`, { data: investigation(), signature: sig('us2', 'wrong') });
    expect(res.statusCode).toBe(401);
    const other = await call(t.app, c.us2!, 'POST', `/api/deviations/${id}/investigate`, { data: investigation(), signature: sig('us3') });
    expect(other.statusCode).toBe(401);
  });
});

describe('corrections', () => {
  it('DV-14: a correction needs a reason, keeps the old version readable and records who and when', async () => {
    const id = await inInvestigation();
    const r = report({ title: 'Punch damage found at line clearance' });
    expect((await call(t.app, c.us1!, 'POST', `/api/deviations/${id}/correct`, { kind: 'report', data: r, reason: '' })).statusCode).toBe(400);
    const ok = await call(t.app, c.us1!, 'POST', `/api/deviations/${id}/correct`, { kind: 'report', data: r, reason: 'Title more precise' });
    expect(ok.statusCode, ok.body).toBe(200);
    const versions = (await get(id)).sections.filter((s: { kind: string }) => s.kind === 'report');
    expect(versions.map((v: { version: number; data: { title: string }; latest: boolean }) => [v.version, v.data.title, v.latest])).toEqual([
      [1, 'Punch damage found', false],
      [2, 'Punch damage found at line clearance', true],
    ]);
    const [a] = await t.owner`select actor_id::int, reason, old_value, new_value from audit_log where action = 'deviation.report_corrected'`;
    expect(a).toMatchObject({ actor_id: ids.us1, reason: 'Title more precise' });
    expect(a!.old_value.title).toBe('Punch damage found');
  });

  it('DV-14: correcting a signed investigation supersedes the signature; it must be signed again', async () => {
    const id = await inInvestigation();
    await investigate(id);
    const res = await call(t.app, c.us2!, 'POST', `/api/deviations/${id}/correct`, { kind: 'investigation', data: investigation({ conclusion: 'Updated after lab result.' }), reason: 'Lab result received' });
    expect(res.json().step).toBe('investigation');
    const d = await get(id);
    expect(d.investigationHash).toMatch(/^[0-9a-f]{64}$/);
    const signed = await call(t.app, c.us2!, 'POST', `/api/deviations/${id}/investigation/sign`, { ...sig('us2'), contentHash: d.investigationHash });
    expect(signed.statusCode, signed.body).toBe(200);
    expect((await get(id)).step).toBe('closure');
  });

  it('DV-14: correcting the report of an approved planned deviation needs a new approval', async () => {
    const id = await inInvestigation(true);
    expect((await get(id)).step).toBe('investigation');
    await call(t.app, c.qa2!, 'POST', `/api/deviations/${id}/correct`, { kind: 'report', data: report({ planned: true, plannedReason: 'Trial of new punch supplier' }), reason: 'Reason clarified' });
    expect((await get(id)).step).toBe('approval');
  });

  it('DV-20: the reporter cannot correct the classification; a changed class recalculates the target date', async () => {
    const id = await inInvestigation();
    const data = { classification: 'critical', typeId, impact: 'Possible metal in tablets.', investigatorId: ids.us2, productBatchChecked: true };
    await seedUser(t.owner, 'qa3', ['qa', 'user']);
    const qa3 = (await login(t.app, 'qa3')).cookie;
    const own = (await call(t.app, qa3, 'POST', '/api/deviations', report())).json().id;
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${own}/classify`, { ...data, classification: 'minor' });
    expect((await call(t.app, qa3, 'POST', `/api/deviations/${own}/correct`, { kind: 'classification', data, reason: 'x' })).statusCode).toBe(403);
    await call(t.app, c.admin1!, 'PUT', '/api/settings', { siteName: 'S', targetDaysMinor: 30, targetDaysMajor: 30, targetDaysCritical: 7, reason: 'test' });
    const before = (await get(id)).targetDate;
    await call(t.app, c.qa2!, 'POST', `/api/deviations/${id}/correct`, { kind: 'classification', data, reason: 'Metal risk' });
    const d = await get(id);
    expect(d.classification).toBe('critical');
    expect(d.targetDate < before).toBe(true);
  });

  it('DV-14: only the reporter or QA corrects the report', async () => {
    const id = await inInvestigation();
    expect((await call(t.app, c.us3!, 'POST', `/api/deviations/${id}/correct`, { kind: 'report', data: report(), reason: 'x' })).statusCode).toBe(403);
  });
});

describe('attachments', () => {
  const pdf = Buffer.from('%PDF-1.4 test file').toString('base64');

  it('DV-21: a file is stored with its SHA-256, listed on the deviation and downloadable as stored', async () => {
    const id = await inInvestigation();
    const res = await call(t.app, c.us1!, 'POST', `/api/deviations/${id}/attachments`, { filename: 'photo.pdf', mime: 'application/pdf', dataBase64: pdf });
    expect(res.statusCode, res.body).toBe(201);
    const d = await get(id);
    expect(d.attachments[0]).toMatchObject({ filename: 'photo.pdf', size: 18, uploadedBy: 'US1' });
    const dl = await t.app.inject({ method: 'GET', url: `/api/attachments/${res.json().id}`, headers: { cookie: c.us3! } });
    expect(dl.body).toBe('%PDF-1.4 test file');
  });

  it('DV-14: an attachment is never deleted, only withdrawn with a reason by its uploader or QA', async () => {
    const id = await inInvestigation();
    const a = (await call(t.app, c.us1!, 'POST', `/api/deviations/${id}/attachments`, { filename: 'x.pdf', mime: 'application/pdf', dataBase64: pdf })).json().id;
    expect((await call(t.app, c.us3!, 'POST', `/api/attachments/${a}/withdraw`, { reason: 'wrong file' })).statusCode).toBe(403);
    expect((await call(t.app, c.us1!, 'POST', `/api/attachments/${a}/withdraw`, { reason: 'Wrong file uploaded' })).statusCode).toBe(200);
    expect((await get(id)).attachments[0].withdrawnReason).toBe('Wrong file uploaded');
    await expect(t.sql`delete from attachments where id = ${a}`).rejects.toThrow(/permission denied/);
  });

  it('only PDF, PNG and JPEG files are accepted', async () => {
    const id = await inInvestigation();
    const res = await call(t.app, c.us1!, 'POST', `/api/deviations/${id}/attachments`, { filename: 'x.exe', mime: 'application/x-msdownload', dataBase64: pdf });
    expect(res.statusCode).toBe(400);
  });
});
