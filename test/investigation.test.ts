import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, sig, freshApp, login, seedUser, type TestApp, directory } from './helpers.js';
import { TOOLS } from './fixtures.js';

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
  initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'Tablets since last IPC segregated.', ...over,
});
const investigation = (over: Record<string, unknown> = {}) => ({
  ...TOOLS,
  rootCause: 'Punch used beyond its life; counter not reset after tooling change.',
  mostLikely: false, humanError: false,
  otherBatches: [{ product: 'Metformin 500', batch: 'MET-10', outcome: 'not_affected' }],
  conclusion: 'No impact on MET-10; MET-11 segregated tablets rejected.',
  ...over,
});

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

  it('DV-04: fishbone causes are saved and signed with the investigation and printed in the PDF; without them it still signs', async () => {
    const id = await inInvestigation();
    const fishbone = { man: 'New operator on night shift.', machine: 'Punch 7 past its life.', method: '', material: '', measurement: 'Counter not reset.', environment: '' };
    expect((await investigate(id, 'us2', investigation({ fishbone }))).statusCode).toBe(200);
    const d = await get(id);
    const s = d.sections.find((x: { kind: string }) => x.kind === 'investigation');
    expect(s.data.fishbone).toEqual(fishbone);
    const pdf = await call(t.app, c.qa1!, 'GET', `/api/deviations/${id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    // Without the older fishbone text it still signs; the 6M (S13) carries the analysis.
    const old = await inInvestigation();
    expect((await investigate(old)).statusCode).toBe(200);
    const o = (await get(old)).sections.find((x: { kind: string }) => x.kind === 'investigation');
    expect(o.data.fishbone).toBeUndefined();
    expect(o.data.sixM.machine.verdict).toBe('ruled_in');
  });

  it('S13: every tool is required, and each missing piece is named: Is / Is Not, 6M with evidence and a ruled-in M, at least 3 whys, the category', async () => {
    const id = await inInvestigation();
    const problemsFor = async (over: Record<string, unknown>) => (await investigate(id, 'us2', investigation(over))).json().problems as string[];
    expect(await problemsFor({ isIsNot: undefined })).toContain('Is / Is Not: required.');
    expect(await problemsFor({ isIsNot: { ...TOOLS.isIsNot, where: { is: 'Press 2', isNot: '', tells: 'x' } } })).toContain('Is / Is Not, where: is not: required.');
    expect(await problemsFor({ sixM: { ...TOOLS.sixM, method: { checked: 'SOP v4', evidence: '', verdict: 'ruled_out' } } })).toContain('6M, Method: evidence: required.');
    const allOut = Object.fromEntries(Object.entries(TOOLS.sixM).map(([k, v]) => [k, { ...v, verdict: 'ruled_out' }]));
    expect(await problemsFor({ sixM: allOut })).toContain('6M: at least one M must be ruled in (the root cause sits there).');
    expect(await problemsFor({ fiveWhys: { problem: 'x', whys: TOOLS.fiveWhys.whys.slice(0, 2) } })).toContain('5 Whys: at least 3 whys, each with evidence.');
    expect(await problemsFor({ fiveWhys: { problem: 'x', whys: [TOOLS.fiveWhys.whys[0], { answer: 'B', evidence: '' }, TOOLS.fiveWhys.whys[2]] } })).toContain('5 Whys, why 2: evidence required.');
    expect(await problemsFor({ rootCauseCategory: '' })).toContain('Choose the root-cause category.');
    // The check lists the same problems and writes nothing.
    const check = await call(t.app, c.us2!, 'POST', `/api/deviations/${id}/investigation/check`, { data: investigation({ rootCauseCategory: undefined }) });
    expect(check.json().problems).toEqual(['Choose the root-cause category.']);
    expect((await call(t.app, c.us2!, 'POST', `/api/deviations/${id}/investigation/check`, { data: investigation() })).json().problems).toEqual([]);
    expect((await get(id)).step).toBe('investigation');
  });

  it('S13: drafts are saved as unsigned versions while investigating, are audited, never move the step, and stop once the investigation is signed', async () => {
    const id = await inInvestigation();
    const draft = (user: string, data: object) => call(t.app, c[user]!, 'POST', `/api/deviations/${id}/investigation/draft`, { data });
    expect((await draft('us2', { rootCause: 'Thinking: feeder?' })).json()).toEqual({ version: 1 });
    expect((await draft('us2', { rootCause: 'Feeder speed', sixM: { machine: { checked: 'speed log' } } })).json()).toEqual({ version: 2 });
    expect((await draft('us3', { rootCause: 'x' })).statusCode).toBe(403);
    // A draft keeps the form's shape, so it can always be shown and printed.
    for (const bad of [{ fiveWhys: { whys: 'x' } }, { isIsNot: { what: null } }, { otherBatches: {} }, { something: 1 }]) {
      expect((await draft('us2', bad)).statusCode).toBe(400);
    }
    const d = await get(id);
    expect(d.step).toBe('investigation');
    const drafts = d.sections.filter((x: { kind: string }) => x.kind === 'investigation_draft');
    expect(drafts.map((x: { version: number; reason: string | null }) => [x.version, x.reason])).toEqual([[1, null], [2, 'Draft saved']]);
    const [n] = await t.owner`select count(*)::int as n from audit_log where action = 'investigation.draft_saved'`;
    expect(n!.n).toBeGreaterThanOrEqual(2);
    expect((await investigate(id)).statusCode).toBe(200);
    expect((await draft('us2', { rootCause: 'late' })).statusCode).toBe(409);
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

  it('DV-17 PL-05: signing needs core\'s fresh proof of the signer\'s own password', async () => {
    const id = await inInvestigation();
    const res = await call(t.app, c.us2!, 'POST', `/api/deviations/${id}/investigate`, { data: investigation(), signature: { proof: 'not-a-proof' } });
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

describe('review fixes (S3)', () => {
  it('DV-02, DV-14: after a report correction a planned deviation can be approved again, and returns to its step', async () => {
    const id = await inInvestigation(true);
    await investigate(id);
    expect((await get(id)).step).toBe('closure');
    await call(t.app, c.us1!, 'POST', `/api/deviations/${id}/correct`, { kind: 'report', data: report({ planned: true, plannedReason: 'Trial of supplier B' }), reason: 'Reason clarified' });
    let d = await get(id);
    expect(d.step).toBe('approval');
    const res = await call(t.app, c.qa2!, 'POST', `/api/deviations/${id}/approve`, { ...sig('qa2'), contentHash: d.approvalHash });
    expect(res.statusCode, res.body).toBe(200);
    d = await get(id);
    // The investigation was signed before and is unchanged, so the deviation goes back to closure.
    expect(d.step).toBe('closure');
    expect(d.investigationHash).toBeNull();
  });

  it('DV-03: a classification correction checks the investigator and type like the first classification', async () => {
    const id = await inInvestigation();
    const gone = await seedUser(t.owner, 'gone1', ['user']);
    directory.get('gone1')!.active = false;   // deactivated in core (PL-08)
    const data = { classification: 'major', typeId, impact: 'x', investigatorId: gone, productBatchChecked: true };
    const res = await call(t.app, c.qa2!, 'POST', `/api/deviations/${id}/correct`, { kind: 'classification', data, reason: 'swap' });
    expect(res.statusCode).toBe(400);
    expect((await get(id)).investigator).toBe('US2');
  });

  it('DV-01: a report correction needs an active area from the list', async () => {
    const id = await inInvestigation();
    const res = await call(t.app, c.us1!, 'POST', `/api/deviations/${id}/correct`, { kind: 'report', data: report({ areaId: 999999 }), reason: 'x' });
    expect(res.statusCode).toBe(400);
  });
});
