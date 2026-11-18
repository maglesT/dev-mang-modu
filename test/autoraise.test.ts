import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { AUTO_AREA, equipmentAt, fileInjectablesNotes, fileProductNotes, noteFeed, scheduleAutoRaise, fileInjectablesPackingNotes, fileLogbookOverdue, filePackingNotes, fileTrueBatchNotes, SOURCE_PREFIX, TB_AREA, TB_PREFIX, TBI_AREA, TBI_PREFIX, TBIP_AREA, TBIP_PREFIX, TBP_AREA, TBP_PREFIX } from '../server/autoraise.js';
import { APP_ROLE, TEST_DATABASE_URL, call, freshApp, login, seedUser, type TestApp } from './helpers.js';
import type { BatchProduct } from '../server/readers/products.js';

// D-50 (owner 2026-11-12, Logbook D-37): missed limits the Logbook publishes in report.overdue_v1 are filed here once,
// as deviations from the automatic reporter; deviation_v1 gives the Logbook the number back through source_ref.
let t: TestApp;
let reader: Sql;
const lb = `lbod_${process.pid}`;
const tb = `tbnote_${process.pid}`;
const tbp = `tbpnote_${process.pid}`;
const tbi = `tbinote_${process.pid}`;
const tbip = `tbipnote_${process.pid}`;
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
  // And for TrueBatch Tablets Packing's, TrueBatch Injectables' and TrueBatch Injectables Packing's, which have the same columns (D-53, D-54, D-55).
  for (const x of [tb, tbp, tbi, tbip]) {
    await t.owner.unsafe(`create schema ${x}`);
    await t.owner.unsafe(`create table ${x}.deviation_note_v1 (note_id bigint, source_ref text, batch_number text, product_code text, step text, note text,
      reference text, status text, noted_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz default now())`);
    await t.owner.unsafe(`grant usage on schema ${x} to ${APP_ROLE}; grant select on ${x}.deviation_note_v1 to ${APP_ROLE}`);
  }
  reader = connect(TEST_DATABASE_URL, { role: APP_ROLE }, 1);
});
afterAll(async () => {
  await reader?.end();
  await t.owner.unsafe(`drop schema if exists ${lb} cascade; drop schema if exists ${tb} cascade; drop schema if exists ${tbp} cascade; drop schema if exists ${tbi} cascade; drop schema if exists ${tbip} cascade`);
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
    const own = await t.owner`select count(*)::int as n from deviations d join users u on u.id = d.reporter_id where u.username not in ('logbook.auto', 'truebatch.auto', 'truebatch_packing.auto', 'truebatch_injectables.auto', 'truebatch_injectables_packing.auto') and d.source_ref is not null`;
    expect(own[0]!.n).toBe(0);
  });
});

async function note(id: number, batch: string, text: string, reference: string | null, hoursAgo: number, step: string | null = 'compression/compress',
  where = { schema: tb, prefix: TB_PREFIX, product: 'MGL-SR-500' }) {
  await t.owner.unsafe(`insert into ${where.schema}.deviation_note_v1 (note_id, source_ref, batch_number, product_code, step, note, reference, status, noted_at) values
    (${id}, '${where.prefix}${id}', '${batch}', '${where.product}', ${step === null ? 'null' : `'${step}'`}, '${text}', ${reference ? `'${reference}'` : 'null'}, ${reference ? `'open'` : 'null'}, now() - interval '${hoursAgo} hours')`);
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
    const [row] = await t.owner<{ source_ref: string; event_at: string; batch: string; product: string; batch_typed: boolean; from: string }[]>`
      select d.source_ref, s.data->>'eventAt' as event_at, b.batch, b.product, b.batch_typed, s.data->'products'->0->>'from' as from from deviations d
      join latest_sections s on s.deviation_id = d.id and s.kind = 'report' join batches b on b.section_id = s.id where d.id = ${d.id}`;
    // D-57: the batch comes from TrueBatch's own note: pulled, not typed by hand.
    expect(row).toMatchObject({ source_ref: `${TB_PREFIX}41`, batch: 'MGL26001', product: 'MGL-SR-500', batch_typed: false, from: 'truebatch' });
    expect(Math.abs(Date.parse(row!.event_at) - (Date.now() - 3 * 3_600_000))).toBeLessThan(120_000);

    // deviation_v1 gives TrueBatch the number back, by source_ref and by the batch.
    const schema = (await t.owner<{ s: string }[]>`select current_schema() as s`)[0]!.s;
    const v = await t.owner.unsafe(`select number, batch_norm, source_ref from ${schema}_report.deviation_v1 where source_ref = '${TB_PREFIX}41'`);
    expect([...v]).toEqual([{ number: d.number, batch_norm: 'mgl26001', source_ref: `${TB_PREFIX}41` }]);
    const [u] = await t.owner<{ employee_id: string | null }[]>`select employee_id from users where username = 'truebatch.auto'`;
    expect(u!.employee_id).toBeNull();
  });

  it('DV-01: the title and text name the step as the view gives it (TrueBatch\'s readable name), with no keys added', async () => {
    await note(45, 'TB260003', 'Impeller power end point 5.6 kW', null, 1, 'Granulation › Granulate to an end point');
    await note(46, 'TB260003', 'Spray rate low', null, 1, '  ');
    const r = await fileTrueBatchNotes(t.sql, tsrc());
    expect(r.filed).toHaveLength(2);
    const rows = await t.owner<{ ref: string; title: string; description: string; action: string }[]>`
      select d.source_ref as ref, s.data->>'title' as title, s.data->>'description' as description, s.data->>'immediateAction' as action
      from deviations d join latest_sections s on s.deviation_id = d.id and s.kind = 'report'
      where d.source_ref in (${TB_PREFIX + '45'}, ${TB_PREFIX + '46'}) order by d.source_ref`;
    expect(rows[0]!.title).toBe('Batch TB260003, Granulation › Granulate to an end point: Impeller power end point 5.6 kW');
    expect(rows[0]!.description).toContain('step Granulation › Granulate to an end point.');
    expect(rows[0]!.action).toContain('(step Granulation › Granulate to an end point)');
    expect(rows.map((x) => x.title).join(' ')).not.toMatch(/granulation\/|\/granulate/);
    expect(rows[1]!.title).toBe('Batch TB260003, step not named: Spray rate low');
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

describe('deviation notes from TrueBatch Packing (D-53)', () => {
  const psrc = () => ({ sql: reader, schema: tbp });
  const packing = { schema: tbp, prefix: TBP_PREFIX, product: 'FG-ATV20-BL10' };

  it('DV-01: a Packing note without a deviation number is filed once, for its product and packing batch, as the Packing automatic reporter', async () => {
    // Note 41 also exists in TrueBatch (filed above): the two systems number their notes on their own.
    await note(41, 'TP260001', 'Coding check 40 min late: line stopped for a jam', null, 2, 'Packing › Coding check', packing);
    await note(47, 'TP260001', 'Leak test repeated', 'DEV-2026-0009', 1, 'Packing › Leak test', packing);   // has a number: never filed
    await note(48, 'TP260002', 'Old note', null, 24 * 40, 'Packing › Coding check', packing);                // older than the look-back
    const first = await filePackingNotes(t.sql, psrc());
    expect(first).toEqual({ filed: [expect.stringMatching(/^DEV-\d{4}-\d{4}$/)], problems: [] });
    expect(await filePackingNotes(t.sql, psrc())).toEqual({ filed: [], problems: [] });   // never twice

    const list = (await call(t.app, c.qa!, 'GET', '/api/deviations?view=all')).json() as { id: number; number: string; title: string; area: string; reporter: string; step: string }[];
    const d = list.find((x) => x.number === first.filed[0])!;
    expect(d).toMatchObject({ title: 'Batch TP260001, Packing › Coding check: Coding check 40 min late: line stopped for a jam', area: TBP_AREA,
      reporter: 'TrueBatch Packing (automatic report)', step: 'classification' });
    const [row] = await t.owner<{ source_ref: string; event_at: string; description: string; batch: string; product: string }[]>`
      select d.source_ref, s.data->>'eventAt' as event_at, s.data->>'description' as description, b.batch, b.product from deviations d
      join latest_sections s on s.deviation_id = d.id and s.kind = 'report' join batches b on b.section_id = s.id where d.id = ${d.id}`;
    expect(row).toMatchObject({ source_ref: `${TBP_PREFIX}41`, batch: 'TP260001', product: 'FG-ATV20-BL10' });
    expect(row!.description).toContain('in the TrueBatch Packing batch record of TP260001, step Packing › Coding check. Filed automatically from TrueBatch Packing.');
    expect(Math.abs(Date.parse(row!.event_at) - (Date.now() - 2 * 3_600_000))).toBeLessThan(120_000);
    // TrueBatch's own note 41 keeps its own deviation.
    expect(await t.owner`select 1 from deviations where source_ref in (${TB_PREFIX + '41'}, ${TBP_PREFIX + '41'})`).toHaveLength(2);

    // deviation_v1 gives Packing the number back by source_ref.
    const schema = (await t.owner<{ s: string }[]>`select current_schema() as s`)[0]!.s;
    const v = await t.owner.unsafe(`select number, batch_norm, source_ref from ${schema}_report.deviation_v1 where source_ref = '${TBP_PREFIX}41'`);
    expect([...v]).toEqual([{ number: d.number, batch_norm: 'tp260001', source_ref: `${TBP_PREFIX}41` }]);
    const [u] = await t.owner<{ employee_id: string | null }[]>`select employee_id from users where username = 'truebatch_packing.auto'`;
    expect(u!.employee_id).toBeNull();
  });

  it('DV-01: with the Packing automatic area made inactive nothing is filed, and the reason is reported', async () => {
    await note(49, 'TP260003', 'Carton count short by 2', null, 1, 'Reconciliation › Reconcile', packing);
    await t.owner`update areas set active = false where name = ${TBP_AREA}`;
    const r = await filePackingNotes(t.sql, psrc());
    expect(r.filed).toEqual([]);
    expect(r.problems[0]).toContain(TBP_AREA);
    await t.owner`update areas set active = true where name = ${TBP_AREA}`;
    expect((await filePackingNotes(t.sql, psrc())).filed).toHaveLength(1);
  });
});

describe('deviation notes from TrueBatch Injectables (D-54)', () => {
  const isrc = () => ({ sql: reader, schema: tbi });
  const inj = { schema: tbi, prefix: TBI_PREFIX, product: 'FG-INJ-EXM2' };

  it('DV-01: an Injectables note without a deviation number is filed once, for its product and batch, as the Injectables automatic reporter', async () => {
    await note(41, 'TI260001', 'Fill weight of needle 3 out of limits: needle replaced', null, 2, 'Filling › Fill with periodic fill-weight checks', inj);
    await note(52, 'TI260001', 'Autoclave load repeated', 'DEV-2026-0010', 1, 'Terminal sterilisation › Terminal sterilisation (each load)', inj);   // has a number: never filed
    await note(53, 'TI260002', 'Old note', null, 24 * 40, 'Filling › Fill', inj);   // older than the look-back
    const first = await fileInjectablesNotes(t.sql, isrc());
    expect(first.filed).toHaveLength(1);
    expect(await fileInjectablesNotes(t.sql, isrc())).toEqual({ filed: [], problems: [] });   // never twice
    const list = (await call(t.app, c.qa!, 'GET', '/api/deviations?view=all')).json() as { id: number; number: string; title: string; area: string; reporter: string }[];
    const d = list.find((x) => x.number === first.filed[0])!;
    expect(d).toMatchObject({ title: 'Batch TI260001, Filling › Fill with periodic fill-weight checks: Fill weight of needle 3 out of limits: needle replaced', area: TBI_AREA,
      reporter: 'TrueBatch Injectables (automatic report)' });
    const [row] = await t.owner<{ source_ref: string; description: string; batch: string; product: string }[]>`
      select d.source_ref, s.data->>'description' as description, b.batch, b.product from deviations d
      join latest_sections s on s.deviation_id = d.id and s.kind = 'report' join batches b on b.section_id = s.id where d.id = ${d.id}`;
    expect(row).toMatchObject({ source_ref: `${TBI_PREFIX}41`, batch: 'TI260001', product: 'FG-INJ-EXM2' });
    expect(row!.description).toContain('in the TrueBatch Injectables batch record of TI260001, step Filling › Fill with periodic fill-weight checks. Filed automatically from TrueBatch Injectables.');
    // The same note number in TrueBatch or Packing is another note: each system numbers its own.
    expect(await t.owner`select 1 from deviations where source_ref in (${TB_PREFIX + '41'}, ${TBP_PREFIX + '41'}, ${TBI_PREFIX + '41'})`).toHaveLength(3);
    const [u] = await t.owner<{ employee_id: string | null }[]>`select employee_id from users where username = 'truebatch_injectables.auto'`;
    expect(u!.employee_id).toBeNull();
  });
});

describe('deviation notes from TrueBatch Injectables Packing (D-55)', () => {
  const ipsrc = () => ({ sql: reader, schema: tbip });
  const injp = { schema: tbip, prefix: TBIP_PREFIX, product: 'FG-INJ-EXM2' };

  it('DV-01: an Injectables Packing note without a deviation number is filed once, for its product and packing batch, as the Injectables Packing automatic reporter', async () => {
    await note(41, 'IP260001', 'Labels short by 120: reconciliation stopped', null, 2, 'Labelling › Label reconciliation', injp);
    await note(62, 'IP260001', 'Carton printer jammed', 'DEV-2026-0011', 1, 'Cartoning › Cartoning', injp);   // has a number: never filed
    await note(63, 'IP260002', 'Old note', null, 24 * 40, 'Labelling › Labelling', injp);   // older than the look-back
    const first = await fileInjectablesPackingNotes(t.sql, ipsrc());
    expect(first.filed).toHaveLength(1);
    expect(await fileInjectablesPackingNotes(t.sql, ipsrc())).toEqual({ filed: [], problems: [] });   // never twice
    const list = (await call(t.app, c.qa!, 'GET', '/api/deviations?view=all')).json() as { id: number; number: string; title: string; area: string; reporter: string }[];
    const d = list.find((x) => x.number === first.filed[0])!;
    expect(d).toMatchObject({ title: 'Batch IP260001, Labelling › Label reconciliation: Labels short by 120: reconciliation stopped', area: TBIP_AREA,
      reporter: 'TrueBatch Injectables Packing (automatic report)' });
    const [row] = await t.owner<{ source_ref: string; description: string; batch: string; product: string }[]>`
      select d.source_ref, s.data->>'description' as description, b.batch, b.product from deviations d
      join latest_sections s on s.deviation_id = d.id and s.kind = 'report' join batches b on b.section_id = s.id where d.id = ${d.id}`;
    expect(row).toMatchObject({ source_ref: `${TBIP_PREFIX}41`, batch: 'IP260001', product: 'FG-INJ-EXM2' });
    expect(row!.description).toContain('in the TrueBatch Injectables Packing batch record of IP260001, step Labelling › Label reconciliation. Filed automatically from TrueBatch Injectables Packing.');
    // The same note number in TrueBatch, Packing or Injectables is another note: each system numbers its own.
    expect(await t.owner`select 1 from deviations where source_ref in (${TB_PREFIX + '41'}, ${TBP_PREFIX + '41'}, ${TBI_PREFIX + '41'}, ${TBIP_PREFIX + '41'})`).toHaveLength(4);
    const [u] = await t.owner<{ employee_id: string | null }[]>`select employee_id from users where username = 'truebatch_injectables_packing.auto'`;
    expect(u!.employee_id).toBeNull();
  });
});

// D-58 (suite run S21): the Equipment of a filed note is pulled from the product's equipment_use_v1 for the note's step.
describe('equipment of a filed note (D-58)', () => {
  const isrc = () => ({ sql: reader, schema: tbi });
  const inj = { schema: tbi, prefix: TBI_PREFIX, product: 'FG-INJ-EXF25' };
  const use = (code: string, room: string, step: string, name: string) => ({ batch_number: 'TI260014', equipment_code: code, room_code: room, step, step_name: name });
  const uses = [
    use('RM-207', 'RM-207', 'filling/line-clearance', 'Aseptic filling'),
    use('EQS-ISO-01', 'RM-207', 'filling/aseptic-ready', 'Aseptic filling › Aseptic set-up'),
    use('EQS-VFM-01', 'RM-207', 'filling/fill', 'Aseptic filling › Fill with periodic fill-weight checks'),
    use('EQS-ATC-01', 'RM-211', 'components/stoppers', 'Containers and closures › Sterilise the stoppers'),
  ];

  it('DV-01: the rooms and machines used at the note\'s step; else those of its stage; none without a step or a use', () => {
    expect(equipmentAt('Aseptic filling › Fill with periodic fill-weight checks', uses)).toEqual({ text: 'Room RM-207; equipment EQS-VFM-01', at: 'step' });
    expect(equipmentAt('Aseptic filling › Line clearance', uses)).toEqual({ text: 'Room RM-207; equipment EQS-ISO-01, EQS-VFM-01', at: 'stage' });
    expect(equipmentAt('components/stoppers', uses)).toEqual({ text: 'Room RM-211; equipment EQS-ATC-01', at: 'step' });   // a note named by keys
    expect(equipmentAt('Aseptic filling › Aseptic set-up (round 2)', uses)?.text).toBe('Room RM-207; equipment EQS-ISO-01');
    expect(equipmentAt('Inspection › Inspect', uses)).toBeNull();
    expect(equipmentAt(null, uses)).toBeNull();
  });

  it('DV-01: a filed note gets its Equipment from equipment_use_v1 when the view is there and readable', async () => {
    await t.owner.unsafe(`create table ${tbi}.equipment_use_v1 (batch_number text, equipment_code text, equipment_type text, room_code text, step text,
      started_at timestamptz, ended_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz default now(), step_name text)`);
    for (const u of uses) {
      await t.owner.unsafe(`insert into ${tbi}.equipment_use_v1 (batch_number, equipment_code, room_code, step, step_name) values ('${u.batch_number}', '${u.equipment_code}', '${u.room_code}', '${u.step}', '${u.step_name}')`);
    }
    await note(71, 'TI260014', 'Filling line refused at line clearance', null, 1, 'Aseptic filling › Line clearance', inj);
    // Not yet granted: filed without equipment, not a failure.
    const first = await fileInjectablesNotes(t.sql, isrc());
    expect(first).toEqual({ filed: [expect.any(String)], problems: [] });
    await t.owner.unsafe(`grant select on ${tbi}.equipment_use_v1 to ${APP_ROLE}`);
    await note(72, 'TI260014', 'Fill weight low', null, 1, 'Aseptic filling › Fill with periodic fill-weight checks', inj);
    const second = await fileInjectablesNotes(t.sql, isrc());
    expect(second.filed).toHaveLength(1);
    const rows = await t.owner<{ ref: string; equipment: string; description: string }[]>`
      select d.source_ref as ref, s.data->>'equipment' as equipment, s.data->>'description' as description from deviations d
      join latest_sections s on s.deviation_id = d.id and s.kind = 'report' where d.source_ref in (${TBI_PREFIX + '71'}, ${TBI_PREFIX + '72'}) order by d.source_ref`;
    expect(rows.map((r) => r.equipment)).toEqual(['', 'Room RM-207; equipment EQS-VFM-01']);
    expect(rows[1]!.description).toContain('Equipment pulled from the TrueBatch Injectables equipment use of TI260014 at this step.');
  });
});

// D-59 (owner 2026-11-18): the new TrueBatch products (one list, server/readers/products.ts) publish the same
// deviation_note_v1; each note is filed by the product's own automatic reporter, in its own area, with its own source_ref.
describe('deviation notes from the new TrueBatch products (D-59)', () => {
  const NEW = [
    { p: 'truebatch_capsules', name: 'TrueBatch Capsules', batch: 'TC260001', product: 'FG-CAP-EX20', step: 'Encapsulation › Fill the capsules' },
    { p: 'truebatch_capsules_packing', name: 'TrueBatch Capsules Packing', batch: 'CP260001', product: 'PK-CAP-EX20-B10', step: 'Blistering › Blister' },
    { p: 'truebatch_liquids', name: 'TrueBatch Oral Liquids', batch: 'TL260001', product: 'FG-SYR-EX5', step: 'Compounding › Dissolve' },
    { p: 'truebatch_liquids_packing', name: 'TrueBatch Oral Liquids Packing', batch: 'LP260001', product: 'PK-SYR-EX5-100', step: 'Filling › Fill the bottles' },
    { p: 'truebatch_api', name: 'TrueBatch API', batch: 'TA260001', product: 'API-EX-01', step: 'Packing › Drum and label' },
  ] as const satisfies readonly { p: BatchProduct; name: string; batch: string; product: string; step: string }[];
  const schemaOf = (p: BatchProduct) => `${p.replace('truebatch_', 'n59')}_${process.pid}`;
  beforeAll(async () => {
    for (const { p } of NEW) {
      const x = schemaOf(p);
      await t.owner.unsafe(`create schema ${x}; create table ${x}.deviation_note_v1 (note_id bigint, source_ref text, batch_number text, product_code text, step text, note text,
        reference text, status text, noted_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz default now());
        grant usage on schema ${x} to ${APP_ROLE}; grant select on ${x}.deviation_note_v1 to ${APP_ROLE}`);
    }
  });
  afterAll(async () => {
    await t.owner.unsafe(NEW.map(({ p }) => `drop schema if exists ${schemaOf(p)} cascade;`).join(' '));
  });

  it('D-59: each product is named after the one list (reporter <key>.auto, area "<name> (automatic)", source_ref <key>:note:)', () => {
    for (const { p, name } of NEW) {
      expect(noteFeed(p)).toEqual({ username: `${p}.auto`, fullName: `${name} (automatic report)`, area: `${name} (automatic)`, prefix: `${p}:note:`, what: `deviation notes from ${name}` });
    }
    // The four products before keep their names exactly.
    expect([TB_AREA, TBP_AREA, TBI_AREA, TBIP_AREA]).toEqual(['TrueBatch (automatic)', 'TrueBatch Packing (automatic)', 'TrueBatch Injectables (automatic)', 'TrueBatch Injectables Packing (automatic)']);
    expect([TB_PREFIX, TBP_PREFIX, TBI_PREFIX, TBIP_PREFIX]).toEqual(['truebatch:note:', 'truebatch_packing:note:', 'truebatch_injectables:note:', 'truebatch_injectables_packing:note:']);
  });

  it('DV-01: a note without a deviation number in each new product is filed once, by its own reporter, in its own area, its batch pulled', async () => {
    for (const { p, name, batch, product, step } of NEW) {
      const where = { schema: schemaOf(p), prefix: noteFeed(p).prefix, product };
      await note(41, batch, 'Out of limits: line stopped', null, 2, step, where);
      await note(42, batch, 'Already reported', 'DEV-2026-0012', 1, step, where);   // has a number: never filed
      const first = await fileProductNotes(t.sql, { sql: reader, schema: schemaOf(p) }, p);
      expect(first).toEqual({ filed: [expect.stringMatching(/^DEV-\d{4}-\d{4}$/)], problems: [] });
      expect(await fileProductNotes(t.sql, { sql: reader, schema: schemaOf(p) }, p)).toEqual({ filed: [], problems: [] });   // never twice
      const [row] = await t.owner<{ source_ref: string; area: string; reporter: string; description: string; batch: string; product: string; typed: boolean; from: string }[]>`
        select d.source_ref, a.name as area, u.full_name as reporter, s.data->>'description' as description, b.batch, b.product, b.batch_typed as typed,
          s.data->'products'->0->>'from' as from
        from deviations d join users u on u.id = d.reporter_id join latest_sections s on s.deviation_id = d.id and s.kind = 'report'
        join areas a on a.id = (s.data->>'areaId')::int join batches b on b.section_id = s.id where d.number = ${first.filed[0]!}`;
      expect(row).toEqual({ source_ref: `${p}:note:41`, area: `${name} (automatic)`, reporter: `${name} (automatic report)`,
        description: `Out of limits: line stopped\n\nDeviation note 41 in the ${name} batch record of ${batch}, step ${step}. Filed automatically from ${name}.`,
        batch, product, typed: false, from: p });
    }
    // Note 41 of every product is its own deviation (each system numbers its own notes).
    expect(await t.owner`select 1 from deviations where source_ref like '%:note:41'`).toHaveLength(4 + NEW.length);
  });

  it('D-59: the schedule files the notes of every linked product; a product without a link is not read, and no error', async () => {
    const [p1, p2] = [NEW[0], NEW[4]];
    await note(43, p1.batch, 'Shell weight low', null, 1, p1.step, { schema: schemaOf(p1.p), prefix: noteFeed(p1.p).prefix, product: p1.product });
    await note(43, p2.batch, 'Drum label torn', null, 1, p2.step, { schema: schemaOf(p2.p), prefix: noteFeed(p2.p).prefix, product: p2.product });
    // Oral Liquids has a note too but no link here: it stays unfiled.
    await note(43, NEW[2].batch, 'Not read', null, 1, NEW[2].step, { schema: schemaOf(NEW[2].p), prefix: noteFeed(NEW[2].p).prefix, product: NEW[2].product });
    const logged: string[] = [];
    const stop = scheduleAutoRaise(t.sql, { [p1.p]: { sql: reader, schema: schemaOf(p1.p) }, [p2.p]: { sql: reader, schema: schemaOf(p2.p) } }, (m) => logged.push(m), 100);
    try {
      for (let i = 0; i < 50 && logged.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    } finally { stop(); }
    expect(logged.sort()).toEqual([
      expect.stringMatching(/^deviation notes from TrueBatch API filed as DEV-/), expect.stringMatching(/^deviation notes from TrueBatch Capsules filed as DEV-/)]);
    const refs = (await t.owner<{ r: string }[]>`select source_ref as r from deviations where source_ref like '%:note:43' order by 1`).map((x) => x.r);
    expect(refs).toEqual(['truebatch_api:note:43', 'truebatch_capsules:note:43']);
  });
});
