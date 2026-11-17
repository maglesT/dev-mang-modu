// Starts the real app with the built UI on a fresh database schema for the browser tests.
import { connect } from '../server/db.js';
import { migrate } from '../db/migrate.js';
import { buildApp } from '../server/app.js';
import globalSetup from '../test/global-setup.js';
import { APP_ROLE, TEST_DATABASE_URL, TEST_PROOF_KEY, fakePeople, fakeSignOn, seedUser } from '../test/helpers.js';
import { E2E_PORT, E2E_SCHEMA, USERS } from './config.js';

await globalSetup();
const owner = connect(TEST_DATABASE_URL);
await owner.unsafe(`drop schema if exists ${E2E_SCHEMA} cascade`);
await owner.unsafe(`create schema ${E2E_SCHEMA}`);
await owner.unsafe(`grant usage on schema ${E2E_SCHEMA} to ${APP_ROLE}`);
await owner.end();

const schemaOwner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
await migrate(schemaOwner);
for (const [username, roles] of Object.entries(USERS)) await seedUser(schemaOwner, username, [...roles]);
await schemaOwner`insert into areas (name) values ('Granulation'), ('Packing')`;
await schemaOwner`insert into deviation_types (name) values ('Process'), ('Equipment')`;
await schemaOwner.end();

// D-57: a stand-in for TrueBatch Injectables' published batch fact, so the report form lists batches to pick from.
const TBI = `${E2E_SCHEMA}_tbi`;
const stand = connect(TEST_DATABASE_URL, {}, 2);
await stand.unsafe(`drop schema if exists ${TBI} cascade; create schema ${TBI};
  create table ${TBI}.batch_fact_v1 (batch_number text, product_code text, product_name text, status text, issued_at timestamptz, released boolean,
    read_at timestamptz default now(), data_as_of timestamptz default now());
  insert into ${TBI}.batch_fact_v1 values ('TI26E01', 'FG-INJ-EX25', 'Example injection 25 mg/mL (invented)', 'IN_PRODUCTION', now() - interval '1 day', false);`);

const sql = connect(TEST_DATABASE_URL, { role: APP_ROLE, searchPath: E2E_SCHEMA });
// Sign-on and signing go through a stand-in for Medhanta core (D-43), which signs in whoever login_hint names.
const app = await buildApp({ sql, signOn: fakeSignOn(), people: fakePeople(), proofKey: TEST_PROOF_KEY, webRoot: new URL('../dist/web', import.meta.url).pathname, cookieSecure: false,
  sources: { truebatch_injectables: { sql: stand, schema: TBI } } });
await app.listen({ port: E2E_PORT, host: '127.0.0.1' });
