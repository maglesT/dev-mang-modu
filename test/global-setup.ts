import postgres from 'postgres';
import { APP_ROLE, TEST_DATABASE_URL } from './helpers.js';

// Roles are cluster-wide: create the app role once, before test files run in parallel.
export default async function setup() {
  const sql = postgres(TEST_DATABASE_URL, { onnotice: () => {} });
  await sql.unsafe(`do $$ begin
    if not exists (select from pg_roles where rolname = '${APP_ROLE}') then create role ${APP_ROLE} nologin; end if;
  end $$`);
  // D-40, D-49: the report roles (capa_report, deviation_report) and the database-wide TEMPORARY change too, once, so migrations of test files
  // running in parallel never race on them (migrations 0010 and 0013 then find them done).
  await sql.unsafe(`do $$ begin
    if not exists (select from pg_roles where rolname = 'capa_report') then create role capa_report nologin; end if;
    if not exists (select from pg_roles where rolname = 'deviation_report') then create role deviation_report nologin; end if;
  end $$`);
  const db = (await sql<{ db: string }[]>`select current_database() as db`)[0]!.db;
  await sql.unsafe(`revoke temporary on database "${db}" from public`);
  await sql.unsafe(`grant temporary on database "${db}" to ${APP_ROLE}`);
  // The test login switches to the app role (SET ROLE), so it must be a member.
  await sql.unsafe(`grant ${APP_ROLE} to current_user`);
  await sql.end();
}
