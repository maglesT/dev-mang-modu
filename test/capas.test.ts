import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';
import { TOOLS } from './fixtures.js';

let t: TestApp;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};
let areaId: number;
let typeId: number;
const inDays = (n: number) => new Date(Date.now() + n * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);
const sig = (u: string) => ({ username: u, password: PASSWORD });

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin1', ['admin']], ['qa1', ['qa', 'user']], ['qa2', ['qa', 'user']], ['us1', ['user']], ['us2', ['user']], ['us3', ['user']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  areaId = (await call(t.app, c.admin1!, 'POST', '/api/areas', { name: 'Packing' })).json().id;
  typeId = (await call(t.app, c.admin1!, 'POST', '/api/deviation-types', { name: 'Material' })).json().id;
});
afterAll(() => t.close());

// A deviation investigated and signed, waiting for closure.
async function awaitingClosure(classification = 'major') {
  const id = (await call(t.app, c.us1!, 'POST', '/api/deviations', {
    planned: false, title: 'Wrong leaflet version', description: 'Leaflet rev 3 found in line; rev 4 is current.', areaId,
    eventAt: new Date(Date.now() - 600_000).toISOString(), products: [{ product: 'Amlodipine 5', batch: 'AML-9' }], initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'Line stopped.',
  })).json().id as number;
  await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, { classification, typeId, impact: 'AML-9.', investigatorId: ids.us2, productBatchChecked: true });
  await call(t.app, c.us2!, 'POST', `/api/deviations/${id}/investigate`, {
    data: { ...TOOLS, rootCause: 'Old stock not removed after revision.', otherBatches: [], noOtherReason: 'Rev 3 issued only to this line.', conclusion: 'Repack AML-9.' },
    signature: sig('us2'),
  });
  return id;
}
const capa = (over: object = {}) => ({ type: 'corrective', description: 'Remove rev 3 leaflets from stores.', ownerId: ids.us3, dueDate: inDays(14), ...over });
const raise = (body: object) => call(t.app, c.qa1!, 'POST', '/api/capas', body);
const getCapa = async (id: number) => (await call(t.app, c.qa1!, 'GET', `/api/capas/${id}`)).json();
const latestVersion = async (id: number) => { const k = await getCapa(id); return k.versions[k.versions.length - 1].id as number; };
const getDev = async (id: number) => (await call(t.app, c.qa1!, 'GET', `/api/deviations/${id}`)).json();
const close = (id: number, data: object = { summary: 'Batch repacked; CAPA raised.' }, user = 'qa1') =>
  call(t.app, c[user]!, 'POST', `/api/deviations/${id}/close`, { data, signature: sig(user) });

describe('CAPA register', () => {
  it('DV-08: QA raises a CAPA from a deviation; it gets a number and is linked to the deviation', async () => {
    const dev = await awaitingClosure();
    const res = await raise(capa({ source: 'deviation', deviationId: dev }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().number).toMatch(/^CAPA-\d{4}-\d{4}$/);
    const list = (await call(t.app, c.us1!, 'GET', `/api/capas?deviationId=${dev}`)).json();
    expect(list).toEqual([expect.objectContaining({ step: 'open', owner: 'US3', deviationNumber: expect.stringMatching(/^DEV-/) })]);
  });

  it('DV-08: a CAPA can be entered directly for an internal audit, complaint or other source, with a reference', async () => {
    expect((await raise(capa({ source: 'audit', sourceRef: '' }))).statusCode).toBe(400);
    const res = await raise(capa({ source: 'audit', sourceRef: 'Internal audit IA-2026-07, finding 3' }));
    expect(res.statusCode).toBe(201);
    const list = (await call(t.app, c.us1!, 'GET', '/api/capas?source=audit')).json();
    expect(list.map((x: { sourceRef: string }) => x.sourceRef)).toContain('Internal audit IA-2026-07, finding 3');
  });

  it('DV-08: only QA raises CAPAs; owner must be an active User or QA; the due date cannot be past', async () => {
    expect((await call(t.app, c.us1!, 'POST', '/api/capas', capa({ source: 'other', sourceRef: 'x' }))).statusCode).toBe(403);
    expect((await raise(capa({ source: 'other', sourceRef: 'x', ownerId: ids.admin1 }))).statusCode).toBe(400);
    expect((await raise(capa({ source: 'other', sourceRef: 'x', dueDate: inDays(-1) }))).statusCode).toBe(400);
  });

  it('DV-08, DV-09, DV-19: done → verified with a dedicated effectiveness check → check result closes it', async () => {
    const { id } = (await raise(capa({ source: 'complaint', sourceRef: 'Complaint MC-118' }))).json();
    const verifyBody = { effectiveness: { mode: 'check', checkDue: inDays(60), how: 'No leaflet mix-up in the next 10 batches.' }, versionId: 0, signature: sig('qa1') };
    expect((await call(t.app, c.qa1!, 'POST', `/api/capas/${id}/verify`, { ...verifyBody, versionId: await latestVersion(id) })).statusCode).toBe(409);
    expect((await call(t.app, c.us2!, 'POST', `/api/capas/${id}/done`, { note: 'x' })).statusCode).toBe(403);
    expect((await call(t.app, c.us3!, 'POST', `/api/capas/${id}/done`, { note: 'Rev 3 stock destroyed, record DR-55.' })).statusCode).toBe(200);
    const v = await call(t.app, c.qa1!, 'POST', `/api/capas/${id}/verify`, { ...verifyBody, versionId: await latestVersion(id) });
    expect(v.json().step).toBe('check');
    const r = await call(t.app, c.qa1!, 'POST', `/api/capas/${id}/check`, { effective: true, note: '10 batches without mix-up.', versionId: await latestVersion(id), signature: sig('qa1') });
    expect(r.statusCode, r.body).toBe(200);
    const k = await getCapa(id);
    expect(k.step).toBe('closed');
    expect(k.signatures.map((s: { meaning: string }) => s.meaning)).toEqual(['verified', 'closed']);
  });

  it('DV-09: "monitored through the trend and review" needs a reason and closes the CAPA at verification', async () => {
    const { id } = (await raise(capa({ source: 'other', sourceRef: 'Management review action 4' }))).json();
    await call(t.app, c.us3!, 'POST', `/api/capas/${id}/done`, { note: 'Done.' });
    expect((await call(t.app, c.qa1!, 'POST', `/api/capas/${id}/verify`, { effectiveness: { mode: 'trend', reason: '' }, versionId: await latestVersion(id), signature: sig('qa1') })).statusCode).toBe(400);
    const v = await call(t.app, c.qa1!, 'POST', `/api/capas/${id}/verify`, { effectiveness: { mode: 'trend', reason: 'Low risk; recurrence seen in the yearly review.' }, versionId: await latestVersion(id), signature: sig('qa1') });
    expect(v.json().step).toBe('closed');
  });

  it('overdue: an open CAPA past its due date is listed as overdue; QA can move the date with a reason', async () => {
    const { id } = (await raise(capa({ source: 'other', sourceRef: 'Overdue example' }))).json();
    await t.owner`update capas set due_date = current_date - 2 where id = ${id}`;
    const overdue = (await call(t.app, c.us1!, 'GET', '/api/capas?overdue=1')).json() as { id: number }[];
    expect(overdue.map((x) => x.id)).toContain(id);
    expect((await call(t.app, c.qa1!, 'POST', `/api/capas/${id}/due-date`, { dueDate: inDays(10), reason: '' })).statusCode).toBe(400);
    expect((await call(t.app, c.qa1!, 'POST', `/api/capas/${id}/due-date`, { dueDate: inDays(10), reason: 'Vendor delay' })).statusCode).toBe(200);
    expect((await getCapa(id)).overdue).toBe(false);
  });

  it('DV-14: a CAPA correction needs a reason and keeps the earlier version; versions cannot be changed by the app', async () => {
    const { id } = (await raise(capa({ source: 'other', sourceRef: 'Correction example' }))).json();
    const res = await call(t.app, c.qa1!, 'POST', `/api/capas/${id}/correct`, { ...capa({ description: 'Remove rev 3 leaflets from stores and line.' }), reason: 'Scope widened' });
    expect(res.statusCode).toBe(200);
    const k = await getCapa(id);
    expect(k.versions.map((v: { action: string; reason: string | null }) => [v.action, v.reason])).toEqual([['raised', null], ['corrected', 'Scope widened']]);
    await expect(t.sql`update capa_versions set data = '{}' where capa_id = ${id}`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from capas where id = ${id}`).rejects.toThrow(/permission denied/);
  });

  it('waiting for me: the owner sees open CAPAs; QA sees CAPAs to verify or check', async () => {
    const { id } = (await raise(capa({ source: 'other', sourceRef: 'Mine example' }))).json();
    expect((await call(t.app, c.us3!, 'GET', '/api/capas?mine=1')).json().map((x: { id: number }) => x.id)).toContain(id);
    await call(t.app, c.us3!, 'POST', `/api/capas/${id}/done`, { note: 'Done.' });
    expect((await call(t.app, c.qa2!, 'GET', '/api/capas?mine=1')).json().map((x: { id: number }) => x.id)).toContain(id);
  });
});

describe('deviation closure', () => {
  it('DV-08, DV-10: a major deviation cannot close without a CAPA', async () => {
    const dev = await awaitingClosure('major');
    const res = await close(dev, { summary: 'Done.', noCapaReason: 'Immediate action enough.' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('capa_required');
  });

  it('DV-10, D-14: QA closes once CAPAs are raised; open CAPAs do not block closure and stay listed', async () => {
    const dev = await awaitingClosure('major');
    await raise(capa({ source: 'deviation', deviationId: dev }));
    expect((await call(t.app, c.us2!, 'POST', `/api/deviations/${dev}/close`, { data: { summary: 'x' }, signature: sig('us2') })).statusCode).toBe(403);
    const res = await close(dev);
    expect(res.statusCode, res.body).toBe(200);
    const d = await getDev(dev);
    expect(d).toMatchObject({ step: 'closed', openCapas: 1 });
    expect(d.signatures.map((s: { meaning: string }) => s.meaning)).toContain('closed');
  });

  it('DV-08: a minor deviation may close without a CAPA only with a reason', async () => {
    const dev = await awaitingClosure('minor');
    expect((await close(dev, { summary: 'Done.' })).statusCode).toBe(400);
    expect((await close(dev, { summary: 'Done.', noCapaReason: 'Immediate segregation was the appropriate action.' })).statusCode).toBe(200);
  });

  it('DV-19: closure is refused before the investigation is signed', async () => {
    const id = (await call(t.app, c.us1!, 'POST', '/api/deviations', {
      planned: false, title: 'x', description: 'x', areaId, eventAt: new Date().toISOString(), products: [], noBatch: true, initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'x',
    })).json().id;
    expect((await close(id)).statusCode).toBe(409);
  });

  it('DV-10: QA reopens a closed deviation with a reason; it can then be corrected and closed again', async () => {
    const dev = await awaitingClosure('minor');
    await close(dev, { summary: 'Done.', noCapaReason: 'Immediate action enough.' });
    expect((await call(t.app, c.us2!, 'POST', `/api/deviations/${dev}/correct`, { kind: 'investigation', data: {}, reason: 'x' })).statusCode).toBe(400);
    const ro = await call(t.app, c.qa2!, 'POST', `/api/deviations/${dev}/reopen`, { reason: 'Customer complaint on AML-9', signature: sig('qa2') });
    expect(ro.statusCode, ro.body).toBe(200);
    expect((await getDev(dev)).step).toBe('closure');
    const again = await close(dev, { summary: 'Re-evaluated; no change.', noCapaReason: 'Immediate action enough.' }, 'qa2');
    expect(again.statusCode, again.body).toBe(200);
  });

  it('a CAPA cannot be raised from a deviation that is not yet classified', async () => {
    const id = (await call(t.app, c.us1!, 'POST', '/api/deviations', {
      planned: false, title: 'x', description: 'x', areaId, eventAt: new Date().toISOString(), products: [], noBatch: true, initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'x',
    })).json().id;
    expect((await raise(capa({ source: 'deviation', deviationId: id }))).statusCode).toBe(409);
  });
});

describe('review fixes (S4)', () => {
  it('DV-16: verifying is refused when the CAPA changed after the page was loaded', async () => {
    const { id } = (await raise(capa({ source: 'other', sourceRef: 'Stale example' }))).json();
    await call(t.app, c.us3!, 'POST', `/api/capas/${id}/done`, { note: 'Done.' });
    const shown = await latestVersion(id);
    await call(t.app, c.qa2!, 'POST', `/api/capas/${id}/correct`, { ...capa({ description: 'Changed meanwhile' }), reason: 'Scope' });
    const res = await call(t.app, c.qa1!, 'POST', `/api/capas/${id}/verify`, { effectiveness: { mode: 'trend', reason: 'x' }, versionId: shown, signature: sig('qa1') });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('content_changed');
  });

  it('a CAPA correction cannot set a past due date', async () => {
    const { id } = (await raise(capa({ source: 'other', sourceRef: 'Past example' }))).json();
    expect((await call(t.app, c.qa1!, 'POST', `/api/capas/${id}/correct`, { ...capa({ dueDate: inDays(-3) }), reason: 'x' })).statusCode).toBe(400);
  });

  it('DV-15: CAPA signatures appear in that CAPA\'s own history', async () => {
    const { id } = (await raise(capa({ source: 'other', sourceRef: 'History example' }))).json();
    await call(t.app, c.us3!, 'POST', `/api/capas/${id}/done`, { note: 'Done.' });
    await call(t.app, c.qa1!, 'POST', `/api/capas/${id}/verify`, { effectiveness: { mode: 'trend', reason: 'Low risk' }, versionId: await latestVersion(id), signature: sig('qa1') });
    expect((await getCapa(id)).history.map((h: { action: string }) => h.action)).toContain('signed.verified');
  });
});
