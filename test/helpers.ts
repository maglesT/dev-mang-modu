import type { FastifyInstance } from 'fastify';
import { connect, type Sql } from '../server/db.js';
import { migrate } from '../db/migrate.js';
import { buildApp, type AppOptions } from '../server/app.js';
import { MEANINGS, makeProof } from '../server/signatures.js';
import { randomUUID } from 'node:crypto';
import { permissionsOf, type Role } from '../server/auth.js';
import type { Identity, SignOn } from '../server/signon.js';
import { ConnectionOff as PeopleOff, type People } from '../server/people.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dev_owner:dev@localhost:5432/dev_test';
export const APP_ROLE = 'deviations_app';

export interface TestDb {
  // Owner connection: migrations and test setup only.
  owner: Sql;
  // Restricted application connection, as the app uses it in production.
  sql: Sql;
  close: () => Promise<void>;
}

// A fresh schema per test file keeps files independent when Vitest runs them in parallel.
export async function freshDb(): Promise<TestDb> {
  const schema = `t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const owner = connect(TEST_DATABASE_URL, { searchPath: schema });
  await owner.unsafe(`create schema ${schema}`);
  await owner.unsafe(`grant usage on schema ${schema} to ${APP_ROLE}`);
  await migrate(owner);
  const sql = connect(TEST_DATABASE_URL, { role: APP_ROLE, searchPath: schema });
  return {
    owner,
    sql,
    close: async () => {
      await sql.end();
      await owner.unsafe(`drop schema ${schema} cascade`);
      // Report views of migrations 0010 and 0013 live in <schema>_report (D-40, D-49).
      await owner.unsafe(`drop schema if exists ${schema}_report cascade`);
      await owner.end();
    },
  };
}

export interface TestApp extends TestDb {
  app: FastifyInstance;
}

export async function freshApp(opts: Partial<AppOptions> = {}): Promise<TestApp> {
  const db = await freshDb();
  const app = await buildApp({ sql: db.sql, signOn: fakeSignOn(), people: fakePeople(), proofKey: TEST_PROOF_KEY, webRoot: '/nonexistent', ...opts });
  return {
    ...db,
    app,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

// People as core knows them (D-43): login -> employee id, name, this product's codes, active.
export const directory = new Map<string, { sub: string; name: string; permissions: string[]; active: boolean }>();

// A stand-in for core's sign-on: it signs in whoever login_hint names, if active in the directory.
export function fakeSignOn(people = directory): SignOn {
  const who = (login: string): Identity => {
    const p = people.get(login);
    if (!p?.active) throw new Error('sign-on refused');
    return { ...p, login, permissions: [...p.permissions], refreshToken: login, idToken: `id-${login}`, authTime: Math.floor(Date.now() / 1000) };
  };
  return {
    authUrl: ({ state, loginHint }) => `/cb?${new URLSearchParams({ state, code: loginHint ?? '' })}`,
    exchange: async (code) => who(code),
    refresh: async (token) => who(token),
    logoutUrl: (idToken) => `/?signed-out=${idToken ?? ''}`,
  };
}

// Stand-in for identity's employee view (D-42 slice 4): active people of the directory; `cut` cuts the link.
export interface FakePeople extends People { cut: boolean }
export function fakePeople(people = directory): FakePeople {
  const f: FakePeople = {
    cut: false,
    active: async (ids) => {
      if (f.cut) throw new PeopleOff();
      return new Set([...people.values()].filter((p) => p.active && ids.includes(p.sub)).map((p) => p.sub));
    },
  };
  return f;
}

// Seeds a person as core knows them, with the codes of the old roles (D-42), and their id-map row (no local password).
export async function seedUser(owner: Sql, username: string, roles: Role[]): Promise<number> {
  const sub = randomUUID();
  directory.set(username, { sub, name: username.toUpperCase(), permissions: permissionsOf(roles), active: true });
  const [u] = await owner<{ id: number }[]>`
    insert into users (employee_id, username, full_name, password_hash, must_change_password)
    values (${sub}, ${username}, ${username.toUpperCase()}, '-', false) returning id::int`;
  return u!.id;
}

// Signing proofs (PL-05): what /cb makes after core re-authenticated the person, for the stand-in's people.
export const TEST_PROOF_KEY = Buffer.alloc(32, 7);
export function proofFor(username: string, at?: number, meanings: string[] = [...MEANINGS]): string {
  const p = directory.get(username);
  return makeProof(TEST_PROOF_KEY, { sub: p?.sub ?? '00000000-0000-0000-0000-000000000000', permissions: p?.permissions ?? [] }, meanings, at);
}
// The signature part of a request body, as the sign dialog sends it.
export const sig = (username: string) => ({ proof: proofFor(username) });

// Signs on through the stand-in for core: /login, then /cb.
export async function login(app: FastifyInstance, username: string) {
  const start = await app.inject({ method: 'GET', url: `/login?login_hint=${encodeURIComponent(username)}` });
  const pending = start.cookies.find((c) => c.name === 'signon');
  const res = await app.inject({ method: 'GET', url: String(start.headers.location), headers: { cookie: `signon=${pending?.value ?? ''}` } });
  const cookie = res.cookies.find((c) => c.name === 'sid');
  return { res, cookie: cookie ? `sid=${cookie.value}` : '' };
}

// JSON request helper carrying the session cookie.
export function call(app: FastifyInstance, cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) {
  return app.inject({ method, url, headers: { cookie }, ...(method === 'GET' ? {} : { payload: payload ?? {} }) });
}
