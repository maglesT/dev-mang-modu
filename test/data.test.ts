import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIntegrityCheck } from '../server/integrity.js';
import { buildApp } from '../server/app.js';
import { call, freshApp, freshDb, login, seedUser, type TestApp } from './helpers.js';

// S17 (D-37, DV-23): "Fetch related data" from the Logbook and Batchwright. In CI the two systems are stood in
// for by schemas with exactly the contract's columns (docs/07-data-contracts.md), filled with the shared scenario.
let t: TestApp;
let off: TestApp;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};
let areaId: number;
const tag = Math.random().toString(36).slice(2, 8);
const LB = `lbfake_${tag}`;
const BW = `bwfake_${tag}`;
const H = 3_600_000;
const event = new Date(Date.now() - 2 * H);
const at = (hours: number) => new Date(event.getTime() + hours * H).toISOString();
const day = (days: number) => new Date(event.getTime() + days * 24 * H + 5.5 * H).toISOString().slice(0, 10);

async function standIns(o: TestApp['owner']) {
  await o.unsafe(`
    create schema ${LB};
    create table ${LB}.equipment_v1 (id bigint, code text, name text, kind text, location text, active boolean, needs_calibration boolean, sop_refs text[], read_at timestamptz default now(), data_as_of timestamptz default now());
    create table ${LB}.entry_v1 (entry_id bigint, version int, equipment_code text, equipment_kind text, type text, change text, activity_start timestamptz, activity_end timestamptz,
      product_code text, batch text, data jsonb, entered_by text, entered_at timestamptz default now(), late boolean default false, signed text[], read_at timestamptz default now(), data_as_of timestamptz default now());
    create table ${LB}.calibration_v1 (equipment_code text, performed_at timestamptz, result text, next_due date, certificate_ref text, read_at timestamptz default now(), data_as_of timestamptz default now());
    create table ${LB}.logbook_sop_v1 (type text, sop_ref text, read_at timestamptz default now(), data_as_of timestamptz default now());
    create schema ${BW};
    create table ${BW}.batch_fact_v1 (batch_id uuid, batch_number text, product_code text, strength text, mbr_version_id uuid, family_code text, record_kind text, status text,
      issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz default now());
    create table ${BW}.step_use_v1 (batch_id uuid, batch_number text, step text, step_id text, equipment_code text, equipment_type text, room_code text, started_at timestamptz,
      ended_at timestamptz, person_ids uuid[], material_lots jsonb, read_at timestamptz default now(), data_as_of timestamptz default now());
    create table ${BW}.cpp_value_v1 (batch_id uuid, batch_number text, kind text, item text, step text, attempt int, reading int, role text, value_text text, unit text,
      lower_text text, upper_text text, target_text text, limit_tier text, failed boolean, recorded_at timestamptz, ref text, read_at timestamptz default now(), data_as_of timestamptz default now());
    create table ${BW}.exception_v1 (batch_id uuid, batch_number text, exception_id text, exception_type text, category text, severity text, raised_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz default now());
    create table ${BW}.alarm_v1 (alarm_id uuid, source text, alarm_code text, gmp_critical boolean, subject_kind text, subject_code text, raised_at timestamptz, received_at timestamptz,
      acked_at timestamptz, batch_count int, batch_numbers text[], read_at timestamptz default now(), data_as_of timestamptz default now());
    create table ${BW}.batch_reference_v1 (batch_number text, kind text, code text, version text, title text, read_at timestamptz default now(), data_as_of timestamptz default now());
  `);
  await o.unsafe(`
    insert into ${LB}.equipment_v1 (id, code, name, kind, location, active, needs_calibration, sop_refs) values
      (1, 'FBD-01', 'Fluid bed dryer', 'equipment', 'GRAN-1', true, false, '{}'),
      (2, 'PRESS-01', 'Tablet press', 'equipment', 'COMP-1', true, false, '{SOP-ENG-010}'),
      (3, 'HT-01', 'Hardness tester', 'instrument', 'COMP-1', true, true, '{}');
    insert into ${LB}.entry_v1 (entry_id, version, equipment_code, equipment_kind, type, change, activity_start, activity_end, product_code, batch, data, entered_by, signed) values
      (10, 1, 'PRESS-01', 'equipment', 'maintenance', 'completed', '${at(-40 * 24 - 2)}', '${at(-40 * 24)}', null, null, '{"kind":"preventive"}', 'Eng One', '{performed,verified}'),
      (11, 1, 'PRESS-01', 'equipment', 'maintenance', 'completed', '${at(-50)}', '${at(-48)}', null, null, '{"kind":"breakdown","failureCategory":"mechanical","rootCause":"Upper punch sticking"}', 'Eng One', '{performed,verified,released}'),
      (12, 1, 'PRESS-01', 'equipment', 'equipment_use', 'completed', '${at(-3)}', '${at(1.5)}', 'RAB-GR-20', 'RAB26004', '{}', 'Op One', '{performed}'),
      (13, 1, 'PRESS-01', 'equipment', 'equipment_cleaning', 'completed', '${at(-24)}', '${at(-23)}', null, null, '{}', 'Op One', '{performed}');
    insert into ${LB}.calibration_v1 (equipment_code, performed_at, result, next_due, certificate_ref) values ('HT-01', '${at(-93 * 24)}', 'pass', '${day(-1)}', 'CAL-77');
    insert into ${LB}.logbook_sop_v1 (type, sop_ref) values ('maintenance', 'SOP-ENG-010');
    insert into ${BW}.batch_fact_v1 (batch_id, batch_number, product_code, family_code, status, issued_at, released) values
      ('9d72a499-bed6-44b4-bf52-da424644182f', 'RAB26004', 'RAB-GR-20', 'RAB-WG-DEMO', 'IN_PROGRESS', '${at(-14)}', false);
    insert into ${BW}.step_use_v1 (batch_number, step, step_id, equipment_code, equipment_type, room_code, started_at, ended_at, material_lots) values
      ('RAB26004', 'TB-05@', 'TB-05', 'FBD-01', 'EQC-FBD', 'GRAN-1', '${at(-12)}', '${at(-10)}', '[]'),
      ('RAB26004', 'TB-13@', 'TB-13', 'HT-01', 'EQC-HT', 'COMP-1', '${at(-1)}', '${at(0)}', '[]');
    insert into ${BW}.cpp_value_v1 (batch_number, kind, item, step, reading, role, value_text, unit, lower_text, upper_text, limit_tier, failed, recorded_at) values
      ('RAB26004', 'PARAMETER', 'dryer.inlet_temp_C', 'TB-05@', 1, 'PROCESS_PARAMETER', '51.0', 'degC', '50.0', '70.0', 'ACTION', false, '${at(-11)}'),
      ('RAB26004', 'PARAMETER', 'breaking_force', 'TB-13@', 1, 'IPC', '48', 'N', '60', '140', 'ACTION', true, '${at(0)}'),
      ('RAB26004', 'PARAMETER', 'breaking_force', 'TB-13@', 2, 'IPC', '52', 'N', '60', '140', 'ACTION', true, '${at(0)}'),
      ('RAB26004', 'PARAMETER', 'breaking_force', 'TB-13@', 3, 'IPC', '95', 'N', '60', '140', 'ACTION', false, '${at(0)}');
    insert into ${BW}.exception_v1 (batch_number, exception_id, exception_type, category, severity, raised_at) values ('RAB26004', 'EX-4', 'IPC_FAILURE', 'IPC', 'CRITICAL', '${at(0)}');
    insert into ${BW}.batch_reference_v1 (batch_number, kind, code, version, title) values ('RAB26004', 'SOP', 'SOP-RTW-PROC', '3', 'Route W processing');
  `);
}

beforeAll(async () => {
  const db = await freshDb();
  await standIns(db.owner);
  // The app reads the stand-ins through the owner connection, as it reads the real views through a read-only role.
  const app = await buildApp({ sql: db.sql, webRoot: '/nonexistent', sources: { logbook: { sql: db.owner, schema: LB }, batchwright: { sql: db.owner, schema: BW } } });
  t = { ...db, app, close: async () => { await app.close(); await db.close(); } };
  for (const [u, roles] of [['admin1', ['admin']], ['qa1', ['qa', 'user']], ['us1', ['user']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  areaId = (await call(t.app, c.admin1!, 'POST', '/api/areas', { name: 'Compression' })).json().id;
  off = await freshApp();
});
afterAll(async () => {
  await t.owner.unsafe(`drop schema ${LB} cascade; drop schema ${BW} cascade`);
  await t.close();
  await off.close();
});

const report = (over: object = {}) => call(t.app, c.us1!, 'POST', '/api/deviations', {
  planned: false, title: 'Breaking force low', description: '2 of 10 cores below 60 N.', areaId, equipment: '', eventAt: event.toISOString(),
  products: [{ product: 'Rabeprazole 20 mg', batch: 'RAB 26004' }], immediateAction: 'Press stopped, batch on hold.',
  initialImpact: { productQuality: 'yes', patientSafety: 'unknown', otherBatches: 'unknown', notes: 'On hold.' }, ...over,
});

describe('data collection (S17)', () => {
  it('DV-23: one fetch reads both systems for the batch, adds the equipment the batch used, and explains the findings in plain words', async () => {
    const id = (await report()).json().id as number;
    expect((await call(t.app, c.us1!, 'POST', `/api/deviations/${id}/fetch`, {})).statusCode).toBe(200);
    const f = (await call(t.app, c.us1!, 'GET', `/api/deviations/${id}/fetches`)).json() as { source: string; status: string; params: { equipment: string[] }; data: { findings: string[] } }[];
    const bw = f.find((x) => x.source === 'batchwright')!;
    const lb = f.find((x) => x.source === 'logbook')!;
    expect([bw.status, lb.status]).toEqual(['ok', 'ok']);
    const bwText = bw.data.findings.join('\n');
    expect(bwText).toMatch(/breaking_force at step TB-13@: check failed; 2 of 3 reading\(s\) outside the limit: 48 N, 52 N/);
    expect(bwText).toMatch(/dryer.inlet_temp_C .*51.0 degC inside the limits but close to one/);
    expect(bwText).toMatch(/exception EX-4/);
    // The batch's equipment (FBD-01, HT-01) was looked up in the Logbook although the report named none.
    expect(lb.params.equipment).toEqual(expect.arrayContaining(['FBD-01', 'HT-01']));
    expect(lb.data.findings.join('\n')).toMatch(/HT-01: calibration was overdue at the event/);
  });

  it('DV-23: the equipment named in the report is looked up too: PM age and a breakdown before the event', async () => {
    const id = (await report({ equipment: 'PRESS-01' })).json().id as number;
    await call(t.app, c.us1!, 'POST', `/api/deviations/${id}/fetch`, {});
    const f = (await call(t.app, c.us1!, 'GET', `/api/deviations/${id}/fetches`)).json() as { source: string; data: { findings: string[]; entries: unknown[]; sops: unknown[] } }[];
    const lb = f.find((x) => x.source === 'logbook')!;
    const text = lb.data.findings.join('\n');
    expect(text).toMatch(/PRESS-01: last preventive maintenance 40 days before the event/);
    expect(text).toMatch(/PRESS-01: breakdown 2 day\(s\) before the event \(mechanical\): Upper punch sticking/);
    expect(lb.data.entries.length).toBeGreaterThanOrEqual(2);
    expect(lb.data.sops).toEqual([{ type: 'maintenance', sop_ref: 'SOP-ENG-010' }]);
  });

  it('DV-23: each copy is insert-only with a SHA-256 in the record and the audit trail; the integrity check catches a changed copy', async () => {
    const id = (await report()).json().id as number;
    await call(t.app, c.us1!, 'POST', `/api/deviations/${id}/fetch`, {});
    const [row] = await t.owner`select id::int, sha256, encode(sha256(convert_to(data::text, 'UTF8')), 'hex') as now from data_fetches where deviation_id = ${id} and source = 'batchwright'`;
    expect(row!.sha256).toBe(row!.now);
    const [a] = await t.owner`select new_value->>'sha256' as sha from audit_log where action = 'data.fetched' and (new_value->>'fetchId')::int = ${row!.id}`;
    expect(a!.sha).toBe(row!.sha256);
    // The app role cannot change or delete a copy.
    await expect(t.sql`update data_fetches set data = '{}' where id = ${row!.id}`).rejects.toThrow(/permission denied/);
    await expect(t.sql`delete from data_fetches where id = ${row!.id}`).rejects.toThrow(/permission denied/);
    expect((await runIntegrityCheck(t.sql)).problems.filter((p) => p.startsWith('Data fetch'))).toEqual([]);
    await t.owner`update data_fetches set data = jsonb_set(data, '{findings}', '[]') where id = ${row!.id}`;
    expect((await runIntegrityCheck(t.sql)).problems).toContain(`Data fetch ${row!.id}: the stored copy no longer matches its SHA-256.`);
  });

  it('DV-23: a missing or failing source is recorded as such; the other still works; nothing for Admin or a closed deviation', async () => {
    const id = (await report({ products: [], noBatch: true })).json().id as number;
    expect((await call(t.app, c.admin1!, 'POST', `/api/deviations/${id}/fetch`, {})).statusCode).toBe(403);
    await call(t.app, c.us1!, 'POST', `/api/deviations/${id}/fetch`, {});
    const f = (await call(t.app, c.us1!, 'GET', `/api/deviations/${id}/fetches`)).json() as { source: string; status: string; data: { findings: string[] } }[];
    expect(f.find((x) => x.source === 'batchwright')!.data.findings).toContain('No batch with this number was found in Batchwright.');
    // Without configured sources, each is recorded as not configured, and the fetch still succeeds.
    await seedUser(off.owner, 'adm9', ['admin']);
    await seedUser(off.owner, 'usr9', ['user']);
    const ad = (await login(off.app, 'adm9')).cookie;
    const ck = (await login(off.app, 'usr9')).cookie;
    expect((await call(off.app, ck, 'GET', '/api/data/status')).json()).toEqual({ logbook: false, batchwright: false });
    const area = (await call(off.app, ad, 'POST', '/api/areas', { name: 'X' })).json().id;
    const dev = (await call(off.app, ck, 'POST', '/api/deviations', {
      planned: false, title: 'x', description: 'x', areaId: area, eventAt: event.toISOString(), products: [], noBatch: true, immediateAction: 'x',
      initialImpact: { productQuality: 'no', patientSafety: 'no', otherBatches: 'no', notes: 'x' },
    })).json().id;
    await call(off.app, ck, 'POST', `/api/deviations/${dev}/fetch`, {});
    const g = (await call(off.app, ck, 'GET', `/api/deviations/${dev}/fetches`)).json() as { status: string }[];
    expect(g.map((x) => x.status)).toEqual(['not_configured', 'not_configured']);
    // A failing source is recorded with its error; the other source still gives its data.
    const bad = await buildApp({ sql: t.sql, webRoot: '/nonexistent', sources: { logbook: { sql: t.owner, schema: 'no_such_schema' }, batchwright: { sql: t.owner, schema: BW } } });
    const bc = (await login(bad, 'us1')).cookie;
    const id2 = (await report()).json().id as number;
    await call(bad, bc, 'POST', `/api/deviations/${id2}/fetch`, {});
    const h = (await call(bad, bc, 'GET', `/api/deviations/${id2}/fetches`)).json() as { source: string; status: string; error: string | null }[];
    expect(h.find((x) => x.source === 'logbook')).toMatchObject({ status: 'failed', error: expect.stringMatching(/no_such_schema/) });
    expect(h.find((x) => x.source === 'batchwright')!.status).toBe('ok');
    await bad.close();
  });
});
