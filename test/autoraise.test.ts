import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { AUTO_AREA, fileLogbookOverdue, fileTrueBatchNotes, SOURCE_PREFIX, TB_AREA, TB_PREFIX } from '../server/autoraise.js';
import { APP_ROLE, TEST_DATABASE_URL, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

// D-50 (owner 2026-11-12, Logbook D-37): missed limits the Logbook publishes in report.overdue_v1 are filed here once,
// as deviations from the automatic reporter; deviation_v1 gives the Logbook the number back through source_ref.
let t: TestApp;
let reader: Sql;
const lb = `lbod_${process.pid}`;
const tb = `tbnote_${process.pid}`;
const c: Record<string, string> = {};
const src = () => ({ sql: reader, schema: lb });

async function overdue(id: number, code: string, hoursAgo: number, detectedDaysAgo = 0) {
  await t.owner.unsafe(`insert into ${lb}.overdue_v1 values (${id}, '${code}', 'pm', now() - interval '${hoursAgo} hours', now() - interval '${detectedDaysAgo} days',
    'Preventive maintenance overdue: ${code} (due 2026-11-10)', 'Equipment ${code} has preventive maintenance every 90 days. Raised automatically by the Logbook.',
    'The Logbook blocks any use of ${code} until its preventive maintenance is recorded and verified.', 'QA to assess the impact.')`);
}

beforeAll(async () => {
  t = await freshApp();
  await seedUser(t.owner, 'arqa', ['qa', 'user']);
  c.qa = (await login(t.app, 'arqa')).cookie;
  // A stand-in for the Logbook's report.overdue_v1, readable by this app's login as through a platform link.
  await t.owner.unsafe(`create schema ${lb}`);
  await t.owner.unsafe(`create table ${lb}.overdue_v1 (event_id bigint, equipment_code text, kind text, due_at timestamptz, detected_at timestamptz,
    title text, description text, immediate_action text, impact_notes text)`);
  await t.owner.unsafe(`grant usage on schema ${lb} to ${APP_ROLE}; grant select on ${lb}.overdue_v1 to ${APP_ROLE}`);
  // A stand-in for TrueBatch's report.deviation_note_v1 (its migration 0006), readable the same way.
  await t.owner.unsafe(`create schema ${tb}`);
  await t.owner.unsafe(`create table ${tb}.deviation_note_v1 (note_id bigint, source_ref text, batch_number text, product_code text, step text, note text,
    reference text, status text, noted_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz default now())`);
  await t.owner.unsafe(`grant usage on schema ${tb} to ${APP_ROLE}; grant select on ${tb}.deviation_note_v1 to ${APP_ROLE}`);
  reader = connect(TEST_DATABASE_URL, { role: APP_ROLE }, 1);
});
afterAll(async () => {
  await reader?.end();
  await t.owner.unsafe(`drop schema if exists ${lb} cascade; drop schema if exists ${tb} cascade`);
  await t.close();
});

describe('missed limits from the Logbook (D-50)', () => {
  it('DV-01: each missed limit is filed once as a deviation from the automatic reporter, with the Logbook\'s text and time', async () => {
    await overdue(7, 'RMG-01', 5);
    await overdue(8, 'OLD-01', 5, 40);   // older than the look-back: not filed
    const first = await fileLogbookOverdue(t.sql, src());
    expect(first).toEqual({ filed: [expect.stringMatching(/^DEV-\d{4}-\d{4}$/)], problems: [] });
    expect(await fileLogbookOverdue(t.sql, src())).toEqual({ filed: [], problems: [] });   // never twice

    const list = (await call(t.app, c.qa!, 'GET', '/api/deviations?view=all')).json() as { id: number; number: string; title: string; area: string; reporter: string; step: string }[];
    const d = list.find((x) => x.number === first.filed[0])!;
    expect(d).toMatchObject({ title: 'Preventive maintenance overdue: RMG-01 (due 2026-11-10)', area: AUTO_AREA, reporter: 'Logbook (automatic report)', step: 'classification' });
    const full = (await call(t.app, c.qa!, 'GET', `/api/deviations/${d.id}`)).json();
    expect(JSON.stringify(full)).toContain('RMG-01');
    const [row] = await t.owner<{ source_ref: string; event_at: string }[]>`
      select d.source_ref, s.data->>'eventAt' as event_at from deviations d join latest_sections s on s.deviation_id = d.id and s.kind = 'report' where d.id = ${d.id}`;
    expect(row!.source_ref).toBe(`${SOURCE_PREFIX}7`);
    expect(Math.abs(Date.parse(row!.event_at) - (Date.now() - 5 * 3_600_000))).toBeLessThan(120_000);
    expect(await t.owner`select 1 from audit_log where action = 'deviation.reported' and object_id = ${String(d.id)}`).toHaveLength(1);

    // deviation_v1 gives the number back with its source.
    const schema = (await t.owner<{ s: string }[]>`select current_schema() as s`)[0]!.s;
    const v = await t.owner.unsafe(`select number, status, title, source_ref from ${schema}_report.deviation_v1 where source_ref = '${SOURCE_PREFIX}7'`);
    expect([...v]).toEqual([{ number: d.number, status: 'classification', title: d.title, source_ref: `${SOURCE_PREFIX}7` }]);
  });

  it('DV-01: with the automatic area made inactive nothing is filed, and the reason is reported', async () => {
    await overdue(9, 'FBD-01', 2);
    await t.owner`update areas set active = false where name = ${AUTO_AREA}`;
    const r = await fileLogbookOverdue(t.sql, src());
    expect(r.filed).toEqual([]);
    expect(r.problems[0]).toContain(AUTO_AREA);
    await t.owner`update areas set active = true where name = ${AUTO_AREA}`;
    expect((await fileLogbookOverdue(t.sql, src())).filed).toHaveLength(1);
  });

  it('DV-01: the automatic reporter cannot sign in (no core employee) and a person\'s own report keeps no source', async () => {
    const [u] = await t.owner<{ employee_id: string | null }[]>`select employee_id from users where username = 'logbook.auto'`;
    expect(u!.employee_id).toBeNull();
    const own = await t.owner`select count(*)::int as n from deviations d join users u on u.id = d.reporter_id where u.username not in ('logbook.auto', 'truebatch.auto') and d.source_ref is not null`;
    expect(own[0]!.n).toBe(0);
  });
});

async function note(id: number, batch: string, text: string, reference: string | null, hoursAgo: number) {
  await t.owner.unsafe(`insert into ${tb}.deviation_note_v1 (note_id, source_ref, batch_number, product_code, step, note, reference, status, noted_at) values
    (${id}, 'truebatch:note:${id}', '${batch}', 'MGL-SR-500', 'compression/compress', '${text}', ${reference ? `'${reference}'` : 'null'}, ${reference ? `'open'` : 'null'}, now() - interval '${hoursAgo} hours')`);
}

describe('deviation notes from TrueBatch (D-51)', () => {
  const tsrc = () => ({ sql: reader, schema: tb });

  it('DV-01: a TrueBatch note without a deviation number is filed once, for its product and batch, as the TrueBatch automatic reporter', async () => {
    await note(41, 'MGL26001', 'Hardness 48 N below the 60 N limit at 10:20', null, 3);
    await note(42, 'MGL26001', 'Timer ran over by 12 min', 'DEV-2026-0007', 2);   // already has a number: never filed
    await note(43, 'MGL26002', 'Old note', null, 24 * 40);                          // older than the look-back
    const first = await fileTrueBatchNotes(t.sql, tsrc());
    expect(first).toEqual({ filed: [expect.stringMatching(/^DEV-\d{4}-\d{4}$/)], problems: [] });
    expect(await fileTrueBatchNotes(t.sql, tsrc())).toEqual({ filed: [], problems: [] });   // never twice

    const list = (await call(t.app, c.qa!, 'GET', '/api/deviations?view=all')).json() as { id: number; number: string; title: string; area: string; reporter: string; step: string }[];
    const d = list.find((x) => x.number === first.filed[0])!;
    expect(d).toMatchObject({ title: 'Batch MGL26001, compression/compress: Hardness 48 N below the 60 N limit at 10:20', area: TB_AREA, reporter: 'TrueBatch (automatic report)', step: 'classification' });
    const [row] = await t.owner<{ source_ref: string; event_at: string; batch: string; product: string }[]>`
      select d.source_ref, s.data->>'eventAt' as event_at, b.batch, b.product from deviations d
      join latest_sections s on s.deviation_id = d.id and s.kind = 'report' join batches b on b.section_id = s.id where d.id = ${d.id}`;
    expect(row).toMatchObject({ source_ref: `${TB_PREFIX}41`, batch: 'MGL26001', product: 'MGL-SR-500' });
    expect(Math.abs(Date.parse(row!.event_at) - (Date.now() - 3 * 3_600_000))).toBeLessThan(120_000);

    // deviation_v1 gives TrueBatch the number back, by source_ref and by the batch.
    const schema = (await t.owner<{ s: string }[]>`select current_schema() as s`)[0]!.s;
    const v = await t.owner.unsafe(`select number, batch_norm, source_ref from ${schema}_report.deviation_v1 where source_ref = '${TB_PREFIX}41'`);
    expect([...v]).toEqual([{ number: d.number, batch_norm: 'mgl26001', source_ref: `${TB_PREFIX}41` }]);
    const [u] = await t.owner<{ employee_id: string | null }[]>`select employee_id from users where username = 'truebatch.auto'`;
    expect(u!.employee_id).toBeNull();
  });

  it('DV-01: with the TrueBatch automatic area made inactive nothing is filed, and the reason is reported', async () => {
    await note(44, 'MGL26003', 'Yield 91 % below 95 %', null, 1);
    await t.owner`update areas set active = false where name = ${TB_AREA}`;
    const r = await fileTrueBatchNotes(t.sql, tsrc());
    expect(r.filed).toEqual([]);
    expect(r.problems[0]).toContain(TB_AREA);
    await t.owner`update areas set active = true where name = ${TB_AREA}`;
    expect((await fileTrueBatchNotes(t.sql, tsrc())).filed).toHaveLength(1);
  });
});
