import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

let t: TestApp;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};
let areaId: number;
let typeId: number;

beforeAll(async () => {
  t = await freshApp();
  for (const [u, roles] of [['admin1', ['admin']], ['qa1', ['qa', 'user']], ['qa2', ['qa', 'user']], ['us1', ['user']], ['us2', ['user']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  areaId = (await call(t.app, c.admin1!, 'POST', '/api/areas', { name: 'Granulation' })).json().id;
  typeId = (await call(t.app, c.admin1!, 'POST', '/api/deviation-types', { name: 'Process' })).json().id;
});
afterAll(() => t.close());

const report = (over: object = {}) => ({
  planned: false,
  title: 'Mixer stopped during granulation',
  description: 'The RMG stopped for 10 minutes due to a power dip.',
  areaId,
  equipment: 'RMG-01',
  eventAt: new Date(Date.now() - 3600_000).toISOString(),
  products: [{ product: 'Paracetamol 500 mg', batch: 'PCM-2401' }],
  immediateAction: 'Restarted after QA informed.',
  ...over,
});
const classify = (over: object = {}) => ({
  classification: 'major', typeId, impact: 'Granule moisture to be checked.', investigatorId: ids.us2, productBatchChecked: true, ...over,
});
const reportAs = async (user: string, over: object = {}) => {
  const res = await call(t.app, c[user]!, 'POST', '/api/deviations', report(over));
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: number; number: string };
};
const get = async (id: number, user = 'qa1') => (await call(t.app, c[user]!, 'GET', `/api/deviations/${id}`)).json();

describe('report', () => {
  it('DV-01: anyone reports a deviation and gets a sequential number that is never reused', async () => {
    const a = await reportAs('us1');
    const b = await reportAs('us1');
    const year = new Date().getFullYear();
    expect(a.number).toMatch(new RegExp(`^DEV-${year}-\\d{4}$`));
    expect(Number(b.number.slice(-4))).toBe(Number(a.number.slice(-4)) + 1);
    expect((await get(a.id)).step).toBe('classification');
  });

  it('DV-01: required fields, and product/batch or an explicit "none"', async () => {
    for (const bad of [{ title: '' }, { immediateAction: '' }, { products: [] }, { areaId: 999999 }]) {
      expect((await call(t.app, c.us1!, 'POST', '/api/deviations', report(bad))).statusCode).toBe(400);
    }
    const none = await call(t.app, c.us1!, 'POST', '/api/deviations', report({ products: [], noBatch: true }));
    expect(none.statusCode).toBe(201);
  });

  it('DV-01: a planned deviation needs the reason for it', async () => {
    const res = await call(t.app, c.us1!, 'POST', '/api/deviations', report({ planned: true }));
    expect(res.statusCode).toBe(400);
    expect(res.json().problems).toContain('Give the reason for the planned deviation.');
  });

  it('DV-13: the event time cannot be in the future; the report time is server time', async () => {
    const future = await call(t.app, c.us1!, 'POST', '/api/deviations', report({ eventAt: new Date(Date.now() + 3600_000).toISOString() }));
    expect(future.statusCode).toBe(400);
    const { id } = await reportAs('us1');
    const d = await get(id);
    expect(Math.abs(new Date(d.reportedAt).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('DV-18: an Admin-only account cannot report a deviation', async () => {
    expect((await call(t.app, c.admin1!, 'POST', '/api/deviations', report())).statusCode).toBe(403);
  });
});

describe('classify', () => {
  it('DV-03: QA classifies; the target date follows the classification and the investigation step opens', async () => {
    const { id } = await reportAs('us1');
    const res = await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, classify());
    expect(res.statusCode, res.body).toBe(200);
    const d = await get(id);
    expect(d).toMatchObject({ step: 'investigation', classification: 'major', investigator: 'US2' });
    const expected = new Date(new Date(d.reportedAt).getTime() + 30 * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);
    expect(d.targetDate).toBe(expected);
  });

  it('DV-03: a plain user cannot classify', async () => {
    const { id } = await reportAs('us1');
    expect((await call(t.app, c.us2!, 'POST', `/api/deviations/${id}/classify`, classify())).statusCode).toBe(403);
  });

  it('DV-20: the reporter cannot classify their own deviation, and product/batch must be confirmed', async () => {
    const { id } = await reportAs('qa1');
    const own = await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, classify());
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toBe('reporter_cannot_classify');
    const unchecked = await call(t.app, c.qa2!, 'POST', `/api/deviations/${id}/classify`, classify({ productBatchChecked: false }));
    expect(unchecked.statusCode).toBe(400);
    expect((await call(t.app, c.qa2!, 'POST', `/api/deviations/${id}/classify`, classify())).statusCode).toBe(200);
  });

  it('DV-19: a deviation is classified only once in its classification step', async () => {
    const { id } = await reportAs('us1');
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, classify());
    expect((await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, classify())).statusCode).toBe(409);
  });

  it('target closure days come from the settings, which Admin changes with a reason (audited)', async () => {
    const put = await call(t.app, c.admin1!, 'PUT', '/api/settings', { siteName: 'Plant 1', targetDaysMinor: 10, targetDaysMajor: 30, targetDaysCritical: 15, reason: 'SOP QA-012 rev 3' });
    expect(put.statusCode).toBe(200);
    const { id } = await reportAs('us1');
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, classify({ classification: 'minor' }));
    const d = await get(id);
    const days = (new Date(d.targetDate).getTime() - new Date(new Date(d.reportedAt).getTime() + 5.5 * 3600_000).setUTCHours(0, 0, 0, 0)) / 86400_000;
    expect(days).toBe(10);
    const [row] = await t.owner`select * from audit_log where action = 'settings.updated'`;
    expect(row!.reason).toBe('SOP QA-012 rev 3');
  });
});

describe('planned deviations', () => {
  const planned = () => reportAs('us1', { planned: true, plannedReason: 'Alternate sieve size while the 1.0 mm sieve is repaired.' });

  it('DV-02: a planned deviation waits for QA approval with an e-signature before it proceeds', async () => {
    const { id } = await planned();
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, classify({ classification: 'minor' }));
    let d = await get(id);
    expect(d.step).toBe('approval');
    const bad = await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/approve`, { username: 'qa1', password: 'wrong', contentHash: d.approvalHash });
    expect(bad.statusCode).toBe(401);
    const ok = await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/approve`, { username: 'qa1', password: PASSWORD, contentHash: d.approvalHash });
    expect(ok.statusCode, ok.body).toBe(200);
    d = await get(id);
    expect(d.step).toBe('investigation');
    expect(d.signatures).toEqual([expect.objectContaining({ meaning: 'approved', printedName: 'QA1' })]);
  });

  it('DV-02: QA can reject a planned deviation with a reason; a plain user cannot approve', async () => {
    const { id } = await planned();
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, classify({ classification: 'minor' }));
    const d = await get(id);
    expect((await call(t.app, c.us2!, 'POST', `/api/deviations/${id}/approve`, { username: 'us2', password: PASSWORD, contentHash: d.approvalHash })).statusCode).toBe(403);
    const res = await call(t.app, c.qa2!, 'POST', `/api/deviations/${id}/reject`, { username: 'qa2', password: PASSWORD, contentHash: d.approvalHash, reason: 'Use the spare sieve instead.' });
    expect(res.statusCode).toBe(200);
    expect((await get(id)).step).toBe('rejected');
  });

  it('DV-16: a signature is refused when the content changed since it was shown', async () => {
    const { id } = await planned();
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, classify({ classification: 'minor' }));
    const res = await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/approve`, { username: 'qa1', password: PASSWORD, contentHash: 'a'.repeat(64) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('content_changed');
  });

  it('DV-18: failed signing attempts count towards lockout', async () => {
    const lock = await seedUser(t.owner, 'qa9', ['qa']);
    const cookie = (await login(t.app, 'qa9')).cookie;
    const { id } = await planned();
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, classify({ classification: 'minor' }));
    const hash = (await get(id)).approvalHash;
    for (let i = 0; i < 5; i++) await call(t.app, cookie, 'POST', `/api/deviations/${id}/approve`, { username: 'qa9', password: 'nope', contentHash: hash });
    const [u] = await t.owner`select locked_at from users where id = ${lock}`;
    expect(u!.locked_at).not.toBeNull();
  });
});

describe('lists and search', () => {
  it('waiting for me: QA sees deviations to classify except their own; the investigator sees theirs', async () => {
    const own = await reportAs('qa1');
    const other = await reportAs('us1');
    const list = (await call(t.app, c.qa1!, 'GET', '/api/deviations?view=mine')).json() as { id: number }[];
    expect(list.map((d) => d.id)).toContain(other.id);
    expect(list.map((d) => d.id)).not.toContain(own.id);
    await call(t.app, c.qa2!, 'POST', `/api/deviations/${other.id}/classify`, classify());
    const inv = (await call(t.app, c.us2!, 'GET', '/api/deviations?view=mine')).json() as { id: number }[];
    expect(inv.map((d) => d.id)).toContain(other.id);
  });

  it('DV-11: the search finds a deviation by batch number, ignoring case, spaces and dashes', async () => {
    const { id } = await reportAs('us1', { products: [{ product: 'Ibuprofen 400', batch: 'IBU-77/A' }] });
    const res = (await call(t.app, c.us2!, 'GET', '/api/deviations?view=all&q=ibu77a')).json() as { id: number }[];
    expect(res.map((d) => d.id)).toEqual([id]);
  });

  it('overdue: past the target date and still open, listed first; QA can move the date with a reason', async () => {
    const { id } = await reportAs('us1');
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, classify());
    await t.owner`update deviations set target_date = current_date - 3 where id = ${id}`;
    const overdue = (await call(t.app, c.us1!, 'GET', '/api/deviations?view=overdue')).json() as { id: number; overdue: boolean }[];
    expect(overdue[0]).toMatchObject({ id, overdue: true });
    const later = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
    expect((await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/target-date`, { targetDate: later, reason: '' })).statusCode).toBe(400);
    expect((await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/target-date`, { targetDate: later, reason: 'Waiting for lab result' })).statusCode).toBe(200);
    const d = await get(id);
    expect(d).toMatchObject({ targetDate: later, overdue: false });
    expect(d.sections.find((s: { kind: string }) => s.kind === 'target_date').data.previous).not.toBe(later);
  });
});

describe('records', () => {
  it('DV-14: the application cannot change or delete section versions, batches or signatures', async () => {
    const { id } = await reportAs('us1');
    for (const stmt of [
      t.sql`update sections set data = '{}' where deviation_id = ${id}`,
      t.sql`delete from sections where deviation_id = ${id}`,
      t.sql`delete from batches where deviation_id = ${id}`,
      t.sql`delete from signatures`,
      t.sql`delete from deviations where id = ${id}`,
    ]) await expect(stmt).rejects.toThrow(/permission denied/);
  });

  it('DV-15: reporting and classifying are in the history with the actor', async () => {
    const { id } = await reportAs('us1');
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, classify());
    const d = await get(id);
    expect(d.history.map((h: { action: string; actor: string }) => [h.action, h.actor])).toEqual([
      ['deviation.reported', 'US1'],
      ['deviation.classified', 'QA1'],
    ]);
  });
});

describe('review fixes (S2)', () => {
  it('an impossible or too-early target date is refused; none can be set while approval is pending', async () => {
    const { id } = await reportAs('us1');
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, classify());
    expect((await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/target-date`, { targetDate: '2026-02-30', reason: 'x' })).statusCode).toBe(400);
    expect((await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/target-date`, { targetDate: '1990-01-01', reason: 'x' })).statusCode).toBe(400);
    const p = await reportAs('us1', { planned: true, plannedReason: 'Trial' });
    await call(t.app, c.qa1!, 'POST', `/api/deviations/${p.id}/classify`, classify({ classification: 'minor' }));
    const later = new Date(Date.now() + 40 * 86400_000).toISOString().slice(0, 10);
    expect((await call(t.app, c.qa1!, 'POST', `/api/deviations/${p.id}/target-date`, { targetDate: later, reason: 'x' })).statusCode).toBe(409);
  });

  it('DV-02: the person who reported a planned deviation cannot approve it', async () => {
    const p = await reportAs('qa1', { planned: true, plannedReason: 'Trial' });
    await call(t.app, c.qa2!, 'POST', `/api/deviations/${p.id}/classify`, classify({ classification: 'minor' }));
    const hash = (await get(p.id)).approvalHash;
    const res = await call(t.app, c.qa1!, 'POST', `/api/deviations/${p.id}/approve`, { username: 'qa1', password: PASSWORD, contentHash: hash });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('reporter_cannot_approve');
  });

  it('DV-11: a batch number needs letters or digits; "%" or "/" in the search match nothing special', async () => {
    expect((await call(t.app, c.us1!, 'POST', '/api/deviations', report({ products: [{ product: 'X', batch: '--' }] }))).statusCode).toBe(400);
    const all = (await call(t.app, c.us1!, 'GET', '/api/deviations?view=all')).json().length;
    expect(all).toBeGreaterThan(0);
    for (const q of ['%', '/', '_']) {
      expect((await call(t.app, c.us1!, 'GET', `/api/deviations?view=all&q=${encodeURIComponent(q)}`)).json()).toHaveLength(0);
    }
  });

  it('area and type names stay unique regardless of case, also when renamed', async () => {
    const id = (await call(t.app, c.admin1!, 'POST', '/api/areas', { name: 'Coating' })).json().id;
    expect((await call(t.app, c.admin1!, 'PATCH', `/api/areas/${id}`, { name: 'granulation', reason: 'x' })).statusCode).toBe(409);
    expect((await call(t.app, c.admin1!, 'POST', '/api/areas', { name: 'COATING' })).statusCode).toBe(409);
  });

  it('a locked account cannot be chosen as investigator', async () => {
    const locked = await seedUser(t.owner, 'lockedinv', ['user']);
    await t.owner`update users set locked_at = now() where id = ${locked}`;
    const people = (await call(t.app, c.qa1!, 'GET', '/api/people')).json() as { id: number }[];
    expect(people.map((p) => p.id)).not.toContain(locked);
    const { id } = await reportAs('us1');
    expect((await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, classify({ investigatorId: locked }))).statusCode).toBe(400);
  });
});
