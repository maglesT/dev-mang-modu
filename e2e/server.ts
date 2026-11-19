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
// D-59: and for TrueBatch Capsules Packing (a new product of the one list), with its packing_batch_v1.
const TCP = `${E2E_SCHEMA}_tcp`;
await stand.unsafe(`drop schema if exists ${TCP} cascade; create schema ${TCP};
  create table ${TCP}.packing_batch_v1 (batch_number text, coded_batch_number text, product_code text, bulk_product_code text, status text, issued_at timestamptz,
    released boolean, read_at timestamptz default now(), data_as_of timestamptz default now());
  insert into ${TCP}.packing_batch_v1 values ('CP26E01', 'TC26E01', 'PK-CAP-EX20-B10', 'FG-CAP-EX20', 'IN_PRODUCTION', now() - interval '2 hours', false);`);
// D-60: a stand-in for LIMS's published OOS (oos_v1): one whose phase I found no laboratory error, one still in phase I.
const LIMS = `${E2E_SCHEMA}_lims`;
await stand.unsafe(`drop schema if exists ${LIMS} cascade; create schema ${LIMS};
  create table ${LIMS}.oos_v1 (oos_id uuid, oos_number text, sample_number text, lot_number text, item_kind text, item_master_id text, item_code text,
    item_name text, analysis_number text, test_key text, test_name text, value numeric, unit text, shown text, limit_text text, status text,
    phase_ii_needed boolean, deviation_number text, opened_at timestamptz, closed_at timestamptz, read_at timestamptz default now(),
    data_as_of timestamptz default now(), outside_lab text);
  insert into ${LIMS}.oos_v1 (oos_id, oos_number, sample_number, lot_number, item_kind, item_code, item_name, analysis_number, test_key, test_name,
    value, unit, shown, limit_text, status, phase_ii_needed, opened_at) values
    (gen_random_uuid(), 'OOS26E001', 'LS26E0001', 'EX26E01', 'PRODUCT', 'FG-EX-10', 'Example tablets 10 mg (invented)', 'LA26E0001', 'assay', 'Assay',
      91.2, '%', '91.2 %', '95.0 to 105.0 %', 'OPEN', true, now() - interval '1 day'),
    (gen_random_uuid(), 'OOS26E002', 'LS26E0002', 'EX26E02', 'PRODUCT', 'FG-EX-10', 'Example tablets 10 mg (invented)', 'LA26E0002', 'diss', 'Dissolution',
      71, '%', '71', 'Q = 80 %', 'OPEN', false, now() - interval '2 hours');`);

const sql = connect(TEST_DATABASE_URL, { role: APP_ROLE, searchPath: E2E_SCHEMA });
// Sign-on and signing go through a stand-in for Medhanta core (D-43), which signs in whoever login_hint names.
const app = await buildApp({ sql, signOn: fakeSignOn(), people: fakePeople(), proofKey: TEST_PROOF_KEY, webRoot: new URL('../dist/web', import.meta.url).pathname, cookieSecure: false,
  sources: { truebatch_injectables: { sql: stand, schema: TBI }, truebatch_capsules_packing: { sql: stand, schema: TCP },
    lims: { sql: stand, schema: LIMS } } });
await app.listen({ port: E2E_PORT, host: '127.0.0.1' });
