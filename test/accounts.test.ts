import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POLICY, sessionKey } from '../server/auth.js';
import { call, freshApp, login, seedUser, type TestApp } from './helpers.js';

let t: TestApp;
let adminCookie: string;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;

beforeAll(async () => {
  t = await freshApp();
  await seedUser(t.owner, 'admin1', ['admin']);
  await seedUser(t.owner, 'qa1', ['qa']);
});
beforeEach(async () => {
  adminCookie = (await login(t.app, 'admin1')).cookie;
});
afterAll(() => t.close());

const auditRows = (action: string, objectId?: number) =>
  objectId === undefined
    ? t.owner`select * from audit_log where action = ${action} order by id`
    : t.owner`select * from audit_log where action = ${action} and object_id = ${String(objectId)} order by id`;

describe('login and sessions', () => {
  it('DV-18: API refuses requests without a session', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('DV-18: login with correct credentials opens a session and is audited', async () => {
    const id = await seedUser(t.owner, uniq('us'), ['user']);
    const username = `us${n}`;
    const { res, cookie } = await login(t.app, username);
    expect(res.statusCode).toBe(200);
    const me = await call(t.app, cookie, 'GET', '/api/me');
    expect(me.json()).toMatchObject({ username, roles: ['user'], passwordChangeRequired: false });
    expect(await auditRows('login', id)).toHaveLength(1);
  });

  it('DV-18: wrong password and unknown user give the same error and are audited', async () => {
    const id = await seedUser(t.owner, uniq('us'), ['user']);
    const wrong = await login(t.app, `us${n}`, 'not-the-password');
    const unknown = await login(t.app, 'nobody-here', 'whatever-123');
    expect(wrong.res.statusCode).toBe(401);
    expect(unknown.res.statusCode).toBe(401);
    expect(wrong.res.json()).toEqual(unknown.res.json());
    expect(await auditRows('login.failed', id)).toHaveLength(1);
  });

  it(`DV-18: session expires after ${POLICY.sessionIdleMinutes} idle minutes`, async () => {
    await seedUser(t.owner, uniq('us'), ['user']);
    const { cookie } = await login(t.app, `us${n}`);
    const sid = sessionKey(cookie.slice(4));
    await t.owner`update sessions set last_seen_at = now() - interval '16 minutes' where id = ${sid}`;
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('DV-18: logout ends the session', async () => {
    await seedUser(t.owner, uniq('us'), ['user']);
    const { cookie } = await login(t.app, `us${n}`);
    await call(t.app, cookie, 'POST', '/api/logout');
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('writes without a JSON body type are refused', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { 'content-type': 'text/plain' },
      payload: 'username=a&password=b',
    });
    expect(res.statusCode).toBe(415);
  });
});

describe('lockout and misuse alert', () => {
  it(`DV-18: ${POLICY.maxFailedAttempts} failed logins lock the account, raise an alert for Admin and QA, and are audited`, async () => {
    const id = await seedUser(t.owner, uniq('us'), ['user']);
    const username = `us${n}`;
    for (let i = 0; i < POLICY.maxFailedAttempts; i++) await login(t.app, username, 'bad-password-1');
    // Even the right password no longer works.
    expect((await login(t.app, username)).res.statusCode).toBe(401);
    expect(await auditRows('user.locked', id)).toHaveLength(1);

    for (const who of ['admin1', 'qa1']) {
      const { cookie } = await login(t.app, who);
      const alerts = (await call(t.app, cookie, 'GET', '/api/alerts')).json();
      expect(alerts.some((a: { message: string }) => a.message.includes(username))).toBe(true);
    }
  });

  it('DV-18: plain users cannot see misuse alerts; acknowledging one is audited', async () => {
    await seedUser(t.owner, uniq('us'), ['user']);
    const username = `us${n}`;
    for (let i = 0; i < POLICY.maxFailedAttempts; i++) await login(t.app, username, 'bad-password-1');
    await seedUser(t.owner, uniq('us'), ['user']);
    const op = await login(t.app, `us${n}`);
    expect((await call(t.app, op.cookie, 'GET', '/api/alerts')).statusCode).toBe(403);

    const qa = await login(t.app, 'qa1');
    const alert = (await call(t.app, qa.cookie, 'GET', '/api/alerts')).json().find((a: { message: string }) => a.message.includes(username));
    expect((await call(t.app, qa.cookie, 'POST', `/api/alerts/${alert.id}/ack`)).statusCode).toBe(200);
    expect(await auditRows('alert.acknowledged', alert.id)).toHaveLength(1);
  });

  it('DV-18: a password reset by Admin unlocks the account with a temporary password', async () => {
    const id = await seedUser(t.owner, uniq('us'), ['user']);
    const username = `us${n}`;
    for (let i = 0; i < POLICY.maxFailedAttempts; i++) await login(t.app, username, 'bad-password-1');
    const reset = await call(t.app, adminCookie, 'POST', `/api/users/${id}/reset-password`, { reason: 'user locked out' });
    const temp = reset.json().temporaryPassword;
    const { res, cookie } = await login(t.app, username, temp);
    expect(res.statusCode).toBe(200);
    expect((await call(t.app, cookie, 'GET', '/api/me')).json().passwordChangeRequired).toBe(true);
    expect(await auditRows('user.password_reset', id)).toHaveLength(1);
  });
});

describe('passwords', () => {
  it('DV-17: a temporary password must be changed before anything else is allowed', async () => {
    const created = await call(t.app, adminCookie, 'POST', '/api/users', { username: uniq('new'), fullName: 'New User', roles: ['user'] });
    const { username } = created.json().user;
    const temp = created.json().temporaryPassword;
    const { cookie } = await login(t.app, username, temp);
    expect((await call(t.app, cookie, 'GET', '/api/alerts')).json()).toEqual({ error: 'password_change_required' });

    const weak = await call(t.app, cookie, 'POST', '/api/me/password', { current: temp, new: 'short' });
    expect(weak.statusCode).toBe(400);
    const ok = await call(t.app, cookie, 'POST', '/api/me/password', { current: temp, new: 'A-much-better-pw-1' });
    expect(ok.statusCode).toBe(200);
    expect((await call(t.app, cookie, 'GET', '/api/me')).json().passwordChangeRequired).toBe(false);
  });

  it(`DV-18: a password older than ${POLICY.passwordMaxAgeDays} days must be changed (11.300(b))`, async () => {
    const id = await seedUser(t.owner, uniq('us'), ['user']);
    await t.owner`update users set password_changed_at = now() - interval '91 days' where id = ${id}`;
    const { cookie } = await login(t.app, `us${n}`);
    expect((await call(t.app, cookie, 'GET', '/api/me')).json().passwordChangeRequired).toBe(true);
  });

  it('DV-17: the API never returns password hashes', async () => {
    const res = await call(t.app, adminCookie, 'GET', '/api/users');
    expect(res.body).not.toContain('scrypt$');
    expect(res.body).not.toContain('password');
  });

  it('DV-17: the audit trail never contains passwords', async () => {
    // Look for password values and hashes, not the word "password" (field names may contain it).
    const rows = await t.owner`select * from audit_log
      where concat(old_value::text, new_value::text, reason) like '%scrypt$%'
         or concat(old_value::text, new_value::text, reason) like '%Correct-Horse-9%'
         or concat(old_value::text, new_value::text, reason) like '%A-much-better-pw-1%'`;
    expect(rows).toHaveLength(0);
  });
});

describe('user administration', () => {
  it('DV-18: only Admin can list and create users', async () => {
    await seedUser(t.owner, uniq('qa'), ['qa', 'user']);
    const { cookie } = await login(t.app, `qa${n}`);
    expect((await call(t.app, cookie, 'GET', '/api/users')).statusCode).toBe(403);
    expect((await call(t.app, cookie, 'POST', '/api/users', { username: 'x-user', fullName: 'X', roles: ['qa'] })).statusCode).toBe(403);
  });

  it('DV-18: creating a user and changing roles are audited with old and new values and a reason', async () => {
    const created = await call(t.app, adminCookie, 'POST', '/api/users', { username: uniq('new'), fullName: 'Asha Rao', roles: ['user'] });
    expect(created.statusCode).toBe(201);
    const id = created.json().user.id;
    expect(await auditRows('user.created', id)).toHaveLength(1);

    const res = await call(t.app, adminCookie, 'PATCH', `/api/users/${id}`, { roles: ['qa', 'user'], reason: 'promoted' });
    expect(res.json().roles).toEqual(['qa', 'user']);
    const [row] = await auditRows('user.updated', id);
    expect(row!.old_value.roles).toEqual(['user']);
    expect(row!.new_value.roles).toEqual(['qa', 'user']);
    expect(row!.reason).toBe('promoted');
  });

  it('DV-18: changes to users need a reason', async () => {
    const created = await call(t.app, adminCookie, 'POST', '/api/users', { username: uniq('new'), fullName: 'No Reason', roles: ['user'] });
    const res = await call(t.app, adminCookie, 'PATCH', `/api/users/${created.json().user.id}`, { fullName: 'Changed' });
    expect(res.statusCode).toBe(400);
  });

  it('DV-18: a deactivated user cannot log in and loses open sessions', async () => {
    const id = await seedUser(t.owner, uniq('us'), ['user']);
    const { cookie } = await login(t.app, `us${n}`);
    await call(t.app, adminCookie, 'PATCH', `/api/users/${id}`, { active: false, reason: 'left the company' });
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await login(t.app, `us${n}`)).res.statusCode).toBe(401);
  });

  it('DV-17: a user ID is never reused, even after the user is deactivated', async () => {
    const id = await seedUser(t.owner, uniq('us'), ['user']);
    await call(t.app, adminCookie, 'PATCH', `/api/users/${id}`, { active: false, reason: 'left' });
    const again = await call(t.app, adminCookie, 'POST', '/api/users', { username: `us${n}`, fullName: 'Someone Else', roles: ['user'] });
    expect(again.statusCode).toBe(409);
  });

  it('DV-17: the application database role cannot rename a user or delete one', async () => {
    const id = await seedUser(t.owner, uniq('us'), ['user']);
    await expect(t.sql`update users set username = 'renamed' where id = ${id}`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from users where id = ${id}`).rejects.toThrow(/permission denied/);
  });

  it('DV-17: an Admin cannot change their own roles or deactivate themselves', async () => {
    const me = (await call(t.app, adminCookie, 'GET', '/api/me')).json();
    const off = await call(t.app, adminCookie, 'PATCH', `/api/users/${me.id}`, { active: false, reason: 'oops' });
    expect(off.statusCode).toBe(400);
    const grant = await call(t.app, adminCookie, 'PATCH', `/api/users/${me.id}`, { roles: ['qa'], reason: 'sign myself' });
    expect(grant.statusCode).toBe(400);
    expect(grant.json().error).toBe('cannot_change_own_account');
    const roles = await t.owner`select role from user_roles where user_id = ${me.id}`;
    expect(roles.map((r) => r.role)).toEqual(['admin']);
  });
});

describe('audit trail', () => {
  it('DV-15: the application cannot change or delete audit rows', async () => {
    await expect(t.sql`update audit_log set action = 'x'`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from audit_log`).rejects.toThrow(/permission denied/);
  });

  it('DV-15: audit rows carry the actor and a server timestamp', async () => {
    await call(t.app, adminCookie, 'POST', '/api/users', { username: uniq('new'), fullName: 'Audit Check', roles: ['qa'] });
    const [row] = await t.owner`select a.*, u.username from audit_log a join users u on u.id = a.actor_id
                                where action = 'user.created' order by a.id desc limit 1`;
    expect(row!.username).toBe('admin1');
    expect(Math.abs(Date.now() - new Date(row!.at).getTime())).toBeLessThan(60_000);
  });
});

describe('review fixes (S1)', () => {
  const background = (cookie: string) =>
    t.app.inject({ method: 'GET', url: '/api/alerts', headers: { cookie, 'x-background-poll': '1' } });

  it('DV-18: background alert polling does not keep an idle session alive', async () => {
    await seedUser(t.owner, uniq('qa'), ['qa']);
    const { cookie } = await login(t.app, `qa${n}`);
    const sid = sessionKey(cookie.slice(4));
    await t.owner`update sessions set last_seen_at = now() - interval '14 minutes' where id = ${sid}`;
    expect((await background(cookie)).statusCode).toBe(200);
    const [row] = await t.owner`select now() - last_seen_at > interval '13 minutes' as stale from sessions where id = ${sid}`;
    expect(row!.stale).toBe(true);
  });

  it('DV-18: a wrong current password on password change counts towards lockout and is audited', async () => {
    const id = await seedUser(t.owner, uniq('us'), ['user']);
    const { cookie } = await login(t.app, `us${n}`);
    for (let i = 0; i < POLICY.maxFailedAttempts; i++) {
      await call(t.app, cookie, 'POST', '/api/me/password', { current: 'wrong-guess-123', new: 'Another-good-pw-9' });
    }
    expect(await auditRows('password.change_failed', id)).toHaveLength(POLICY.maxFailedAttempts);
    expect(await auditRows('user.locked', id)).toHaveLength(1);
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('DV-18: changing the password ends the user\'s other sessions', async () => {
    await seedUser(t.owner, uniq('us'), ['user']);
    const first = await login(t.app, `us${n}`);
    const second = await login(t.app, `us${n}`);
    await call(t.app, second.cookie, 'POST', '/api/me/password', { current: 'Correct-Horse-9', new: 'Fresh-secret-pw-7' });
    expect((await call(t.app, first.cookie, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await call(t.app, second.cookie, 'GET', '/api/me')).statusCode).toBe(200);
  });

  it('DV-17: a temporary password expires after 24 hours', async () => {
    const created = await call(t.app, adminCookie, 'POST', '/api/users', { username: uniq('new'), fullName: 'Late Starter', roles: ['user'] });
    const { id, username } = created.json().user;
    await t.owner`update users set temp_password_expires_at = now() - interval '1 minute' where id = ${id}`;
    expect((await login(t.app, username, created.json().temporaryPassword)).res.statusCode).toBe(401);
  });

  it('DV-17: turning a temporary password into a personal one is marked in the audit trail', async () => {
    const created = await call(t.app, adminCookie, 'POST', '/api/users', { username: uniq('new'), fullName: 'First Login', roles: ['user'] });
    const { cookie } = await login(t.app, created.json().user.username, created.json().temporaryPassword);
    await call(t.app, cookie, 'POST', '/api/me/password', { current: created.json().temporaryPassword, new: 'My-own-secret-42' });
    const [row] = await auditRows('password.changed', created.json().user.id);
    expect(row!.new_value).toEqual({ fromTemporaryPassword: true });
  });

  it('DV-15: the application cannot choose the audit timestamp', async () => {
    await expect(
      t.sql`insert into audit_log (at, action, object_type) values (now() - interval '1 year', 'x', 'y')`,
    ).rejects.toThrow(/permission denied/);
  });

  it('DV-18: session ids are stored only as hashes', async () => {
    await seedUser(t.owner, uniq('us'), ['user']);
    const { cookie } = await login(t.app, `us${n}`);
    const raw = cookie.slice(4);
    expect(await t.owner`select 1 from sessions where id = ${raw}`).toHaveLength(0);
    expect(await t.owner`select 1 from sessions where id = ${sessionKey(raw)}`).toHaveLength(1);
  });

  it('non-numeric ids are rejected with 400', async () => {
    const res = await call(t.app, adminCookie, 'PATCH', '/api/users/abc', { fullName: 'x', reason: 'y' });
    expect(res.statusCode).toBe(400);
  });
});

describe('audit trail view', () => {
  it('DV-15: QA and Admin read the audit trail with actor names; plain users cannot', async () => {
    await seedUser(t.owner, 'reader1', ['user']);
    const qa = (await login(t.app, 'qa1')).cookie;
    const rows = (await call(t.app, qa, 'GET', '/api/audit?user=qa1')).json();
    expect(rows[0]).toMatchObject({ action: 'login', actor: 'QA1' });
    const plain = (await login(t.app, 'reader1')).cookie;
    expect((await call(t.app, plain, 'GET', '/api/audit')).statusCode).toBe(403);
  });

  it('DV-15: the audit trail lists rows whose object is not a number (unknown-user login, integrity check)', async () => {
    await login(t.app, 'no-such-user', 'wrong-password');
    await t.owner`insert into audit_log (action, object_type, object_id) values ('integrity.passed', 'system', 'integrity')`;
    // Enough users for the planner to join users by hash, which computes the join key for every audit row.
    for (let i = 0; i < 200; i++) await seedUser(t.owner, uniq('bulk'), ['user']);
    await t.owner`analyze`;
    const qa = (await login(t.app, 'qa1')).cookie;
    const all = await call(t.app, qa, 'GET', '/api/audit');
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'login.failed', subject: 'no-such-user' }),
      expect.objectContaining({ objectType: 'system', objectId: 'integrity' }),
    ]));
    expect((await call(t.app, qa, 'GET', '/api/audit?user=qa1')).statusCode).toBe(200);
  });
});

describe('review fixes (S1, deviations)', () => {
  it('DV-18: the Admin role cannot be combined with User or QA', async () => {
    const res = await call(t.app, adminCookie, 'POST', '/api/users', { username: uniq('mix'), fullName: 'Mixed', roles: ['admin', 'qa'] });
    expect(res.statusCode).toBe(400);
    const id = await seedUser(t.owner, uniq('plain'), ['user']);
    const upd = await call(t.app, adminCookie, 'PATCH', `/api/users/${id}`, { roles: ['admin', 'user'], reason: 'test' });
    expect(upd.statusCode).toBe(400);
  });

  it('DV-15: the audit trail shows user IDs, and the user filter includes failed logins against that user', async () => {
    await seedUser(t.owner, 'target1', ['user']);
    await login(t.app, 'target1', 'wrong-password');
    const qa = (await login(t.app, 'qa1')).cookie;
    const rows = (await call(t.app, qa, 'GET', '/api/audit?user=target1')).json();
    expect(rows[0]).toMatchObject({ action: 'login.failed', subject: 'target1', actor: null });
    const own = (await call(t.app, qa, 'GET', '/api/audit?user=qa1')).json();
    expect(own[0]).toMatchObject({ actorUsername: 'qa1' });
  });
});
