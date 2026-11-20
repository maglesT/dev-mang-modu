import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { CPV_FEED, fileCpvSignals, scheduleAutoRaise } from '../server/autoraise.js';
import { APP_ROLE, TEST_DATABASE_URL, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

// D-66 (Operations D-28): each CPV signal QA sent to Deviations in Operations (report.cpv_signal_v1) is filed here once,
// by ops.auto in the area "Operations CPV (automatic)", for its product and batch (pulled), with the parameter and rule.
let t: TestApp;
let reader: Sql;
const ops = `opscpv_${process.pid}`;
const c: Record<string, string> = {};
const src = () => ({ sql: reader, schema: ops });

async function signal(id: number, batch: string, item: string, what: string, note = '', daysAgo = 0) {
  await t.owner.unsafe(`insert into ${ops}.cpv_signal_v1 (signal_id, product_code, product_name, item_label, batch, what, note, title, description, sent_by, sent_at, read_at, data_as_of)
    values (${id}, 'FG-EX-10', 'Example tablets 10 mg (invented)', '${item}', '${batch}', '${what}', '${note}',
      'Continued process verification: ${item}, batch ${batch}', '${what}' || case when '${note}' <> '' then E'\\n' || '${note}' else '' end,
      'QA Example', now() - interval '${daysAgo} days', now(), now() - interval '${daysAgo} days')`);
}

beforeAll(async () => {
  t = await freshApp();
  await seedUser(t.owner, 'cpvqa', ['qa', 'user']);
  c.qa = (await login(t.app, 'cpvqa')).cookie;
  // A stand-in for Operations' report.cpv_signal_v1 (its migration 0016, same columns), readable as through a platform link.
  await t.owner.unsafe(`create schema ${ops}; create table ${ops}.cpv_signal_v1 (signal_id bigint, product_code text, product_name text, item_label text,
    batch text, what text, note text, title text, description text, sent_by text, sent_at timestamptz, read_at timestamptz, data_as_of timestamptz);
    grant usage on schema ${ops} to ${APP_ROLE}; grant select on ${ops}.cpv_signal_v1 to ${APP_ROLE}`);
  reader = connect(TEST_DATABASE_URL, { role: APP_ROLE }, 1);
});
afterAll(async () => {
  await reader?.end();
  await t.owner.unsafe(`drop schema if exists ${ops} cascade`);
  await t.close();
});

describe('CPV signals from Operations (D-66)', () => {
  it('DV-01: each signal is filed once, by the Operations automatic reporter, for its product and batch (pulled), with the parameter and rule', async () => {
    await signal(5, 'EX26005', 'Tablet hardness', 'Tablet hardness: batch EX26005 value 61 N; out of trend, Nelson rule 1.', 'Seen in the November review.');
    await signal(6, 'EX26001', 'Yield', 'Yield: batch EX26001 value 90 %; outside the specification 95 to 100 %.', '', 40);   // older than the look-back
    const first = await fileCpvSignals(t.sql, src());
    expect(first).toEqual({ filed: [expect.stringMatching(/^DEV-\d{4}-\d{4}$/)], problems: [] });
    expect(await fileCpvSignals(t.sql, src())).toEqual({ filed: [], problems: [] });   // never twice

    const [row] = await t.owner<{ source_ref: string; area: string; reporter: string; username: string; title: string; description: string; batch: string; product: string; typed: boolean; from: string; planned: boolean }[]>`
      select d.source_ref, a.name as area, u.full_name as reporter, u.username, s.data->>'title' as title, s.data->>'description' as description,
        b.batch, b.product, b.batch_typed as typed, s.data->'products'->0->>'from' as from, d.planned
      from deviations d join users u on u.id = d.reporter_id join latest_sections s on s.deviation_id = d.id and s.kind = 'report'
      join areas a on a.id = (s.data->>'areaId')::int join batches b on b.section_id = s.id where d.number = ${first.filed[0]!}`;
    expect(row).toEqual({ source_ref: 'ops:cpv:5', area: 'Operations CPV (automatic)', reporter: 'Operations CPV (automatic report)', username: 'ops.auto',
      title: 'Continued process verification: Tablet hardness, batch EX26005',
      description: 'Tablet hardness: batch EX26005 value 61 N; out of trend, Nelson rule 1.\nSeen in the November review.\n\nContinued process verification (CPV) signal 5 in Operations: '
        + 'product Example tablets 10 mg (invented) (FG-EX-10), batch EX26005, parameter Tablet hardness. Sent to Deviations in Operations by QA Example. Filed automatically from Operations.',
      batch: 'EX26005', product: 'FG-EX-10', typed: false, from: 'ops', planned: false });
    expect(CPV_FEED.prefix).toBe('ops:cpv:');
    // QA sees it like any other report, waiting for classification; the audit trail has its filing.
    const list = (await call(t.app, c.qa!, 'GET', '/api/deviations?view=all')).json() as { number: string; area: string; step: string }[];
    expect(list.find((x) => x.number === first.filed[0])).toMatchObject({ area: 'Operations CPV (automatic)', step: 'classification' });
    expect(await t.owner`select 1 from audit_log where action = 'deviation.reported' and new_value->>'sourceRef' = 'ops:cpv:5'`).toHaveLength(1);
  });

  it('DV-01: with the area made inactive nothing is filed and the reason is reported; the automatic reporter cannot sign in', async () => {
    await signal(7, 'EX26007', 'Fill weight', 'Fill weight: batch EX26007 value 252 mg; out of trend, Nelson rule 2.');
    await t.owner`update areas set active = false where name = ${CPV_FEED.area}`;
    const r = await fileCpvSignals(t.sql, src());
    expect(r.filed).toEqual([]);
    expect(r.problems[0]).toContain(CPV_FEED.area);
    await t.owner`update areas set active = true where name = ${CPV_FEED.area}`;
    expect((await fileCpvSignals(t.sql, src())).filed).toHaveLength(1);
    const [u] = await t.owner<{ password_hash: string }[]>`select password_hash from users where username = 'ops.auto'`;
    expect(u!.password_hash).toBe('!');
  });

  it('DV-01: a person cannot mark a batch as from Operations: it comes only with its CPV signal', async () => {
    const [a] = await t.owner<{ id: number }[]>`insert into areas (name) values ('CPV test area') returning id::int`;
    const res = await call(t.app, c.qa!, 'POST', '/api/deviations', { planned: false, title: 'Typed', description: 'Typed', areaId: a!.id, equipment: '',
      eventAt: new Date().toISOString(), products: [{ product: 'FG-EX-10', batch: 'EX26099', from: 'ops' }], noBatch: false, immediateAction: 'None', actionTakenAt: null,
      initialImpact: { productQuality: 'unknown', patientSafety: 'unknown', otherBatches: 'unknown', notes: 'To assess.' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('comes only with its CPV signal');
  });

  it('D-66: the schedule files the signals while Operations is linked; without the link nothing is read', async () => {
    await signal(8, 'EX26008', 'Assay', 'Assay: batch EX26008 value 94.1 %; outside the specification 95 to 105 %.');
    const logged: string[] = [];
    const stop = scheduleAutoRaise(t.sql, { ops: src() }, (m) => logged.push(m), 100);
    try {
      for (let i = 0; i < 50 && !logged.length; i++) await new Promise((r) => setTimeout(r, 100));
    } finally { stop(); }
    expect(logged).toEqual([expect.stringMatching(/^CPV signals from Operations filed as DEV-/)]);
    expect(await t.owner`select 1 from deviations where source_ref = 'ops:cpv:8'`).toHaveLength(1);
  });
});
