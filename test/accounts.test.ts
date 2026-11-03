import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLICY, ROLE_PERMISSIONS, sessionKey } from '../server/auth.js';
import { buildApp } from '../server/app.js';
import { oidcSignOn } from '../server/signon.js';
import { call, directory, fakeSignOn, freshApp, login, seedUser, type TestApp } from './helpers.js';

// D-43: people, passwords, lockout and the permission register are Medhanta core's; Deviations signs people on
// through core (stand-in: helpers.fakeSignOn) and keeps sessions, per-action authority checks and its audit trail.

let t: TestApp;
let n = 0;
const uniq = (p: string) => `${p}${++n}`;

beforeAll(async () => {
  t = await freshApp();
  await seedUser(t.owner, 'admin1', ['admin']);
  await seedUser(t.owner, 'qa1', ['qa']);
});
afterAll(() => t.close());

const auditRows = (action: string, objectId?: number) =>
  objectId === undefined
    ? t.owner`select * from audit_log where action = ${action} order by id`
    : t.owner`select * from audit_log where action = ${action} and object_id = ${String(objectId)} order by id`;
const sid = (cookie: string) => sessionKey(cookie.slice(4));

describe('sign-on through core (PL-01)', () => {
  it('DV-18: API refuses requests without a session', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('DV-18 PL-01: /login sends the browser to core; sign-on opens a session with the codes from core and is audited', async () => {
    const id = await seedUser(t.owner, uniq('us'), ['user']);
    const username = `us${n}`;
    const start = await t.app.inject({ method: 'GET', url: `/login?login_hint=${username}` });
    expect(start.statusCode).toBe(302);
    const { res, cookie } = await login(t.app, username);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect((await call(t.app, cookie, 'GET', '/api/me')).json()).toEqual({ id, username, fullName: username.toUpperCase(),
      permissions: ROLE_PERMISSIONS.user });
    expect(await auditRows('login', id)).toHaveLength(1);
  });

  it('DV-18 PL-01: the oidc client asks core for a code with PKCE and for this product\'s codes (scope permissions)', () => {
    const s = oidcSignOn({ issuer: 'https://site.test/oidc', clientId: 'deviations', clientSecret: 'x', redirectUri: 'https://deviations.site.test/cb' });
    const url = new URL(s.authUrl({ state: 'st', challenge: 'ch' }));
    expect(url.origin + url.pathname).toBe('https://site.test/oidc/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'deviations', response_type: 'code', code_challenge: 'ch',
      code_challenge_method: 'S256', state: 'st', redirect_uri: 'https://deviations.site.test/cb', scope: 'openid profile permissions' });
  });

  it('PL-01 a person without a Deviations permission is refused at sign-in, and the refusal is audited', async () => {
    const id = await seedUser(t.owner, uniq('nobody'), []);
    const { res, cookie } = await login(t.app, `nobody${n}`);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('no right to use Deviations');
    expect(cookie).toBe('');
    expect(await auditRows('login.failed', id)).toHaveLength(1);
  });

  it('DV-18 PL-01: codes come from core only; a role in the old local table or a code of another product gives no right', async () => {
    const id = await seedUser(t.owner, uniq('us'), ['user']);
    await t.owner`insert into user_roles (user_id, role) values (${id}, 'qa')`;
    directory.get(`us${n}`)!.permissions.push('mms.audit.read', 'deviations.unknown');
    const { cookie } = await login(t.app, `us${n}`);
    expect((await call(t.app, cookie, 'GET', '/api/me')).json().permissions).toEqual(ROLE_PERMISSIONS.user);
    expect((await call(t.app, cookie, 'GET', '/api/audit')).statusCode).toBe(403);
  });

  it('PL-01 each action checks its permission, whatever else the person holds; reading needs any Deviations code', async () => {
    await seedUser(t.owner, uniq('aud'), []);
    directory.get(`aud${n}`)!.permissions = ['deviations.audit.read'];
    const { cookie } = await login(t.app, `aud${n}`);
    expect((await call(t.app, cookie, 'GET', '/api/audit')).statusCode).toBe(200);
    expect((await call(t.app, cookie, 'GET', '/api/deviations')).statusCode).toBe(200);
    expect((await call(t.app, cookie, 'GET', '/api/capas')).statusCode).toBe(200);
    expect((await call(t.app, cookie, 'POST', '/api/deviations', {})).statusCode).toBe(403);
    expect((await call(t.app, cookie, 'POST', '/api/capas', {})).statusCode).toBe(403);
    expect((await call(t.app, cookie, 'POST', '/api/areas', { name: 'x' })).statusCode).toBe(403);
    const settings = await seedUser(t.owner, uniq('set'), []);
    directory.get(`set${n}`)!.permissions = ['deviations.settings.manage'];
    const admin = (await login(t.app, `set${n}`)).cookie;
    expect((await call(t.app, admin, 'POST', '/api/areas', { name: `Area ${settings}` })).statusCode).toBe(201);
    expect((await call(t.app, admin, 'GET', '/api/audit')).statusCode).toBe(403);
  });

  it('DV-18 (D-42): the role table covers every code; Admin keeps only audit reading and settings', () => {
    expect(ROLE_PERMISSIONS.admin).toEqual(['deviations.audit.read', 'deviations.settings.manage']);
    expect(ROLE_PERMISSIONS.qa).toEqual(expect.arrayContaining(ROLE_PERMISSIONS.user));
    expect(new Set(Object.values(ROLE_PERMISSIONS).flat()).size).toBe(11);   // every code is given by some old role
  });

  it('PL-01 a sign-in this browser did not start is refused (no login CSRF)', async () => {
    const made = await t.app.inject({ method: 'GET', url: '/cb?code=admin1&state=made-up' });
    expect(made.statusCode).toBe(400);
    const theirs = await t.app.inject({ method: 'GET', url: '/login?login_hint=admin1' });
    const res = await t.app.inject({ method: 'GET', url: String(theirs.headers.location) });
    expect(res.statusCode).toBe(400);
    expect(res.cookies.find((c) => c.name === 'sid')).toBeUndefined();
  });

  it(`DV-18 PL-01: a revoked code or a deactivated person is out within ${POLICY.permissionCheckMinutes} minutes (renewal through core)`, async () => {
    await seedUser(t.owner, uniq('qa'), ['qa']);
    const username = `qa${n}`;
    const { cookie } = await login(t.app, username);
    directory.get(username)!.permissions = ['deviations.audit.read'];
    expect((await call(t.app, cookie, 'GET', '/api/me')).json().permissions).toContain('deviations.deviation.close');
    await t.owner`update sessions set checked_at = now() - interval '6 minutes' where id = ${sid(cookie)}`;
    expect((await call(t.app, cookie, 'GET', '/api/me')).json().permissions).toEqual(['deviations.audit.read']);

    directory.get(username)!.active = false;
    await t.owner`update sessions set checked_at = now() - interval '6 minutes' where id = ${sid(cookie)}`;
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
    // The ended session keeps only its ID token (for a later logout); no codes and no refresh token are left.
    const [row] = await t.owner`select permissions, refresh_token from sessions where id = ${sid(cookie)}`;
    expect(row).toMatchObject({ permissions: [], refresh_token: null });
  });

  it('PL-01 a renewal without a new refresh token keeps the old one, so the session lives on (RFC 6749 6)', async () => {
    const inner = fakeSignOn();
    const app = await buildApp({ sql: t.sql, signOn: { ...inner, refresh: async (tok) => ({ ...(await inner.refresh(tok)), refreshToken: undefined }) }, webRoot: '/nonexistent' });
    try {
      await seedUser(t.owner, uniq('us'), ['user']);
      const { cookie } = await login(app, `us${n}`);
      for (let i = 0; i < 2; i++) {
        await t.owner`update sessions set checked_at = now() - interval '6 minutes' where id = ${sid(cookie)}`;
        expect((await call(app, cookie, 'GET', '/api/me')).statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it('DV-17 PL-01: a login that cannot be mapped (taken by a local account not yet moved) is refused', async () => {
    await t.owner`insert into users (username, full_name, password_hash) values ('oldie', 'Old Local', '-')`;
    directory.set('oldie', { sub: randomUUID(), name: 'Old Local', permissions: [...ROLE_PERMISSIONS.user], active: true });
    const { res, cookie } = await login(t.app, 'oldie');
    expect(res.statusCode).toBe(403);
    expect(cookie).toBe('');
  });

  it(`DV-18: session expires after ${POLICY.sessionIdleMinutes} idle minutes`, async () => {
    await seedUser(t.owner, uniq('us'), ['user']);
    const { cookie } = await login(t.app, `us${n}`);
    await t.owner`update sessions set last_seen_at = now() - interval '16 minutes' where id = ${sid(cookie)}`;
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('DV-18 PL-01: logout after the session went idle still ends the core session (ID token hint; shared terminals)', async () => {
    await seedUser(t.owner, uniq('us'), ['user']);
    const { cookie } = await login(t.app, `us${n}`);
    await t.owner`update sessions set last_seen_at = now() - interval '16 minutes' where id = ${sid(cookie)}`;
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
    const out = await call(t.app, cookie, 'POST', '/api/logout');
    expect(out.json().logoutUrl).toBe(`/?signed-out=id-us${n}`);
    expect(await t.owner`select 1 from sessions where id = ${sid(cookie)}`).toHaveLength(0);
  });

  it('DV-18 PL-01: logout ends the session and sends the browser to end the core session too', async () => {
    await seedUser(t.owner, uniq('us'), ['user']);
    const { cookie } = await login(t.app, `us${n}`);
    const out = await call(t.app, cookie, 'POST', '/api/logout');
    expect(out.json().logoutUrl).toBe(`/?signed-out=id-us${n}`);
    expect((await call(t.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('writes without a JSON body type are refused', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/logout', headers: { 'content-type': 'text/plain' }, payload: 'x' });
    expect(res.statusCode).toBe(415);
  });

  it('DV-18: session ids are stored only as hashes', async () => {
    await seedUser(t.owner, uniq('us'), ['user']);
    const { cookie } = await login(t.app, `us${n}`);
    const raw = cookie.slice(4);
    expect(await t.owner`select 1 from sessions where id = ${raw}`).toHaveLength(0);
    expect(await t.owner`select 1 from sessions where id = ${sessionKey(raw)}`).toHaveLength(1);
  });

  it('DV-18: background polling does not keep an idle session alive', async () => {
    await seedUser(t.owner, uniq('qa'), ['qa']);
    const { cookie } = await login(t.app, `qa${n}`);
    await t.owner`update sessions set last_seen_at = now() - interval '14 minutes' where id = ${sid(cookie)}`;
    const bg = await t.app.inject({ method: 'GET', url: '/api/alerts', headers: { cookie, 'x-background-poll': '1' } });
    expect(bg.statusCode).toBe(200);
    const [row] = await t.owner`select now() - last_seen_at > interval '13 minutes' as stale from sessions where id = ${sid(cookie)}`;
    expect(row!.stale).toBe(true);
  });

  it('DV-18: the local login, password and user routes are gone (core does them)', async () => {
    const { cookie } = await login(t.app, 'admin1');
    expect((await t.app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin1', password: 'x' } })).statusCode).toBe(404);
    expect((await call(t.app, cookie, 'POST', '/api/me/password', { current: 'x', new: 'y' })).statusCode).toBe(404);
    expect((await call(t.app, cookie, 'GET', '/api/users')).statusCode).toBe(404);
  });
});

describe('user ids and audit trail', () => {
  it('DV-17: the application database role cannot rename a user, re-point a login to another person or delete one', async () => {
    const id = await seedUser(t.owner, uniq('us'), ['user']);
    await expect(t.sql`update users set username = 'renamed' where id = ${id}`).rejects.toThrow(/permission denied/);
    await expect(t.sql`update users set employee_id = gen_random_uuid() where id = ${id}`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from users where id = ${id}`).rejects.toThrow(/permission denied/);
  });

  it('DV-17: the application no longer writes passwords, lockout state or roles (core does)', async () => {
    const id = await seedUser(t.owner, uniq('us'), ['user']);
    await expect(t.sql`update users set password_hash = 'x' where id = ${id}`).rejects.toThrow(/permission denied/);
    await expect(t.sql`update users set locked_at = now() where id = ${id}`).rejects.toThrow(/permission denied/);
    await expect(t.sql`insert into user_roles (user_id, role) values (${id}, 'qa')`).rejects.toThrow(/permission denied/);
  });

  it('DV-17: the API never returns password hashes and the audit trail never contains them', async () => {
    const admin = await login(t.app, 'admin1');
    expect((await call(t.app, admin.cookie, 'GET', '/api/me')).body).not.toContain('scrypt$');
    const rows = await t.owner`select 1 from audit_log where concat(old_value::text, new_value::text, reason) like '%scrypt$%'`;
    expect(rows).toHaveLength(0);
  });

  it('DV-15: the application cannot change or delete audit rows', async () => {
    await expect(t.sql`update audit_log set action = 'x'`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from audit_log`).rejects.toThrow(/permission denied/);
  });

  it('DV-15: audit rows carry the actor and a server timestamp', async () => {
    await login(t.app, 'admin1');
    const [row] = await t.owner`select a.*, u.username from audit_log a join users u on u.id = a.actor_id
                                where action = 'login' order by a.id desc limit 1`;
    expect(row!.username).toBe('admin1');
    expect(Math.abs(Date.now() - new Date(row!.at).getTime())).toBeLessThan(60_000);
  });

  it('DV-15: the application cannot choose the audit timestamp', async () => {
    await expect(
      t.sql`insert into audit_log (at, action, object_type) values (now() - interval '1 year', 'x', 'y')`,
    ).rejects.toThrow(/permission denied/);
  });
});

describe('audit trail view', () => {
  it('DV-15: holders of deviations.audit.read read the audit trail with actor names; others cannot', async () => {
    await seedUser(t.owner, 'reader1', ['user']);
    const qa = (await login(t.app, 'qa1')).cookie;
    const rows = (await call(t.app, qa, 'GET', '/api/audit?user=qa1')).json();
    expect(rows[0]).toMatchObject({ action: 'login', actor: 'QA1' });
    const plain = (await login(t.app, 'reader1')).cookie;
    expect((await call(t.app, plain, 'GET', '/api/audit')).statusCode).toBe(403);
  });

  it('DV-15: the audit trail lists rows whose object is not a number (integrity check)', async () => {
    await t.owner`insert into audit_log (action, object_type, object_id) values ('integrity.passed', 'system', 'integrity')`;
    // Enough users for the planner to join users by hash, which computes the join key for every audit row.
    for (let i = 0; i < 200; i++) await seedUser(t.owner, uniq('bulk'), ['user']);
    await t.owner`analyze`;
    const qa = (await login(t.app, 'qa1')).cookie;
    const all = await call(t.app, qa, 'GET', '/api/audit');
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual(expect.arrayContaining([expect.objectContaining({ objectType: 'system', objectId: 'integrity' })]));
    expect((await call(t.app, qa, 'GET', '/api/audit?user=qa1')).statusCode).toBe(200);
    // Seeds 200 users and runs ANALYZE: slow on a busy machine.
  }, 60_000);

  it('DV-15: the audit trail shows user IDs, and the user filter includes refused sign-ins of that user', async () => {
    await seedUser(t.owner, 'target1', []);
    await login(t.app, 'target1');
    const qa = (await login(t.app, 'qa1')).cookie;
    const rows = (await call(t.app, qa, 'GET', '/api/audit?user=target1')).json();
    expect(rows[0]).toMatchObject({ action: 'login.failed', subject: 'target1' });
    const own = (await call(t.app, qa, 'GET', '/api/audit?user=qa1')).json();
    expect(own[0]).toMatchObject({ actorUsername: 'qa1' });
  });
});
