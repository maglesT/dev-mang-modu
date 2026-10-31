import type { FastifyInstance } from 'fastify';
import { connect, type Sql } from '../server/db.js';
import { migrate } from '../db/migrate.js';
import { buildApp } from '../server/app.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dev_owner:dev@localhost:5432/dev_test';
export const APP_ROLE = 'dev_app';

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
      await owner.end();
    },
  };
}

export interface TestApp extends TestDb {
  app: FastifyInstance;
}

export async function freshApp(): Promise<TestApp> {
  const db = await freshDb();
  const app = await buildApp({ sql: db.sql, webRoot: '/nonexistent' });
  return {
    ...db,
    app,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
