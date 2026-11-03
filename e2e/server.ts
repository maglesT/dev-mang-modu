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

const sql = connect(TEST_DATABASE_URL, { role: APP_ROLE, searchPath: E2E_SCHEMA });
// Sign-on and signing go through a stand-in for Medhanta core (D-43), which signs in whoever login_hint names.
const app = await buildApp({ sql, signOn: fakeSignOn(), people: fakePeople(), proofKey: TEST_PROOF_KEY, webRoot: new URL('../dist/web', import.meta.url).pathname, cookieSecure: false });
await app.listen({ port: E2E_PORT, host: '127.0.0.1' });
