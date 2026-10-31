import postgres from 'postgres';
import { APP_ROLE, TEST_DATABASE_URL } from './helpers.js';

// Roles are cluster-wide: create the app role once, before test files run in parallel.
export default async function setup() {
  const sql = postgres(TEST_DATABASE_URL, { onnotice: () => {} });
  await sql.unsafe(`do $$ begin
    if not exists (select from pg_roles where rolname = '${APP_ROLE}') then create role ${APP_ROLE} nologin; end if;
  end $$`);
  // The test login switches to the app role (SET ROLE), so it must be a member.
  await sql.unsafe(`grant ${APP_ROLE} to current_user`);
  await sql.end();
}
