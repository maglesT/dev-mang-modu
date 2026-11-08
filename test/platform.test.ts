import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { MIGRATIONS_DIR } from '../db/migrate.js';
import { loadConfig } from '../server/config.js';
import { APP_ROLE, freshDb, TEST_DATABASE_URL, type TestDb } from './helpers.js';

// D-42 (slice 1): the Deviations migrations on a Medhanta platform database. test/platform/database.sql is a copy of
// the platform's db/server/database.sql (maglesT/databsee aa81e20). As on the platform, each migration runs in its own
// transaction as the database's owner role (NOLOGIN, no superuser, cannot create roles), and init runs again before
// later migrations, so its default grants are back by then.

const DB = `devplat_${process.pid}`;
const OWNER = `${DB}_owner`;
const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, 'platform', name), 'utf8')
    .replaceAll(':"owner"', `"${OWNER}"`).replaceAll(":'owner'", `'${OWNER}'`)
    .replaceAll(':"app"', `"${APP_ROLE}"`).replaceAll(":'app'", `'${APP_ROLE}'`)
    .replaceAll(':"db"', `"${DB}"`).replaceAll(":'db'", `'${DB}'`);
// database.sql has its own begin/commit; the test runs its body in one transaction instead.
const init = () => su.begin((tx) => tx.unsafe(fixture('database.sql').replace(/^(begin|commit);$/gm, '')));

const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
// What a platform install of the live Deviations runs at once; later migrations come with later applies.
const FIRST_INSTALL = files.filter((f) => f < '0011');

let admin: Sql;
let su: Sql;
let standalone: TestDb;

async function migrateAsOwner(names: string[]) {
  for (const f of names)
    await su.begin(async (tx) => {
      await tx.unsafe(`set local role ${OWNER}`);
      await tx.unsafe(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    });
}

/** Every right the app login holds on the tables, views, columns and sequences of one schema, by object name. */
async function appRights(q: Sql, schema: string) {
  const rows = await q<{ r: string }[]>`
    select c.relname || ' ' || a.privilege_type as r
    from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
    where n.nspname = ${schema} and c.relkind in ('r', 'v', 'S') and a.grantee = ${APP_ROLE}::regrole
    union all
    select c.relname || '.' || t.attname || ' ' || a.privilege_type
    from pg_attribute t join pg_class c on c.oid = t.attrelid join pg_namespace n on n.oid = c.relnamespace, aclexplode(t.attacl) a
    where n.nspname = ${schema} and t.attacl is not null and a.grantee = ${APP_ROLE}::regrole
    order by 1`;
  return rows.map((x) => x.r).filter((r) => !r.startsWith('schema_migrations '));
}

const columns = (q: Sql, schema: string, view = 'capa_v1') => q<{ name: string; type: string }[]>`
  select a.attname as name, format_type(a.atttypid, a.atttypmod) as type
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = ${schema} and c.relname = ${view} and a.attnum > 0 and not a.attisdropped order by a.attnum`;

beforeAll(async () => {
  admin = connect(TEST_DATABASE_URL.replace(/\/[^/]+$/, '/postgres'));
  await admin.unsafe(`drop database if exists ${DB}`);
  // What the platform's db/server/cluster.sql does for one database (the app role exists from the global setup).
  await admin.unsafe(`do $$ begin if not exists (select from pg_roles where rolname = '${OWNER}') then create role ${OWNER} nologin; end if; end $$`);
  await admin.unsafe(`create database ${DB} owner ${OWNER}`);
  await admin.unsafe(`revoke all on database ${DB} from public`);
  await admin.unsafe(`grant connect, temporary on database ${DB} to ${APP_ROLE}`);
  su = connect(TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${DB}`));
  await init();
  await migrateAsOwner(FIRST_INSTALL);
  await init();                // a later apply runs init again
  await migrateAsOwner(files.filter((f) => !FIRST_INSTALL.includes(f)));
  standalone = await freshDb();
}, 60_000);

afterAll(async () => {
  await standalone?.close();
  await su?.end();
  await admin?.unsafe(`drop database if exists ${DB}`);
  await admin?.unsafe(`drop role if exists ${OWNER}`);
  await admin?.end();
});

describe('Deviations on a platform database (D-42)', () => {
  it('DV-14 DV-15 the app login has exactly the rights of a standalone installation, so records and the audit trail stay insert-only', async () => {
    const schema = (await standalone.owner<{ s: string }[]>`select current_schema() as s`)[0]!.s;
    const platform = await appRights(su, 'public');
    expect(platform.length).toBeGreaterThan(20);
    expect(platform).toEqual(await appRights(standalone.owner, schema));
    for (const t of ['audit_log', 'sections', 'signatures', 'capa_versions'])
      for (const p of ['UPDATE', 'DELETE']) expect(platform).not.toContain(`${t} ${p}`);
    expect(platform).not.toContain('audit_log INSERT');   // the platform default would have granted every column
  });

  it('DV-15 the app login cannot change an audit row or a signature on the platform database', async () => {
    const app = connect(TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${DB}`), { role: APP_ROLE });
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
    expect(await code(app`update audit_log set action = 'x'`)).toBe('42501');
    expect(await code(app`delete from signatures`)).toBe('42501');
    await app.end();
  });

  it('DV-08 report.capa_v1 for the QMS link: same name, version and columns on the platform as standalone', async () => {
    const schema = (await standalone.owner<{ s: string }[]>`select current_schema() as s`)[0]!.s;
    const platform = await columns(su, 'report');
    expect(platform.map((c) => c.name)).toEqual(['number', 'status', 'due_date', 'deviation_number', 'description', 'source', 'read_at', 'data_as_of']);
    expect(platform).toEqual(await columns(standalone.owner, `${schema}_report`));
    // The platform's link switch can grant it: a published view in schema report, named <name>_v<n>.
    expect((await su`select 1 from pg_views where schemaname = 'report' and viewname = 'capa_v1'`).length).toBe(1);
  });

  it('DV-11 report.deviation_v1 for the Batchwright link: same name, version and columns on the platform as standalone', async () => {
    const schema = (await standalone.owner<{ s: string }[]>`select current_schema() as s`)[0]!.s;
    const platform = await columns(su, 'report', 'deviation_v1');
    expect(platform.map((c) => c.name)).toEqual(['number', 'status', 'classification', 'opened_at', 'closed_at',
      'product', 'batch', 'batch_norm', 'outcome', 'read_at', 'data_as_of']);
    expect(platform).toEqual(await columns(standalone.owner, `${schema}_report`, 'deviation_v1'));
    expect((await su`select 1 from pg_views where schemaname = 'report' and viewname = 'deviation_v1'`).length).toBe(1);
  });

  it('DV-15 on the platform the app reads its own database from DEVIATIONS_DATABASE_URL, and the Logbook from LOGBOOK_DATABASE_URL', () => {
    const url = 'postgres://deviations_app:pw@db:5432/deviations';
    const env = { DEVIATIONS_DATABASE_URL: url, LOGBOOK_DATABASE_URL: 'postgres://deviations_app:pw@db:5432/logbook',
      OIDC_ISSUER: 'https://site.test/oidc', OIDC_CLIENT_SECRET: 'x', OIDC_REDIRECT_URI: 'https://deviations.site.test/cb',
      IDENTITY_DATABASE_URL: 'postgres://deviations_app:pw@db:5432/identity' };
    expect(loadConfig(env).DATABASE_URL).toBe(url);
    expect(loadConfig(env).DB_APP_ROLE).toBeUndefined();
    expect(loadConfig(env).LOGBOOK_REPORT_URL).toBe('postgres://deviations_app:pw@db:5432/logbook');
    expect(loadConfig(env).BATCHWRIGHT_REPORT_URL).toBeUndefined();   // Batchwright not licensed or not linked
    // Linked to Batchwright (ebmr, D-48): apply writes EBMR_DATABASE_URL; a standalone BATCHWRIGHT_REPORT_URL still wins.
    const ebmr = 'postgres://deviations_app:pw@db:5432/ebmr';
    expect(loadConfig({ ...env, EBMR_DATABASE_URL: ebmr }).BATCHWRIGHT_REPORT_URL).toBe(ebmr);
    expect(loadConfig({ ...env, EBMR_DATABASE_URL: ebmr, BATCHWRIGHT_REPORT_URL: 'postgres://x:y@h/ebmr' }).BATCHWRIGHT_REPORT_URL).toBe('postgres://x:y@h/ebmr');
    expect(loadConfig(env).OIDC_CLIENT_ID).toBe('deviations');
    expect(loadConfig({ ...env, DATABASE_URL: 'postgres://x:y@h/standalone' }).DATABASE_URL).toBe('postgres://x:y@h/standalone');
    expect(loadConfig({ ...env, DATABASE_URL: '', LOGBOOK_REPORT_URL: ' ' })).toMatchObject({ DATABASE_URL: url, LOGBOOK_REPORT_URL: env.LOGBOOK_DATABASE_URL });
  });
});
