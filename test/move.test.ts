import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { migrate, MIGRATIONS_DIR } from '../db/migrate.js';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../server/auth.js';
import { contentHash } from '../server/signatures.js';
import { check, runIntegrityCheck } from '../server/integrity.js';
import { moveToPlatform, reportCsv, type MoveOptions, type MoveResult } from '../db/move-to-platform.js';
import { APP_ROLE, TEST_DATABASE_URL } from './helpers.js';

// Slice 5 (D-45, platform PL-13): the move of the standalone Deviations onto the platform, after MMS's
// test/move.test.ts. The source is a standalone Deviations: migrations 0001–0010 as on branch `standalone` (2b49b4a),
// copied to test/platform/standalone (role dev_app). The platform side is built as on a server: the deviations database
// by the platform init (test/platform/database.sql) and all migrations as the owner role; core's identity database
// from copies of its migrations (test/platform/identity: maglesT/databsee 6df3e5e).

const fixtures = path.join(import.meta.dirname, 'platform');
const url = (db: string) => TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${db}`);
const tag = (t: string) => `devmv_${process.pid}_${t}`;
let admin: Sql;
const open: Sql[] = [];
const dbs: string[] = [];
const conn = (db: string, opts = {}) => { const s = connect(url(db), opts); open.push(s); return s; };

const hash = (pw: string, salt = randomBytes(16)) =>
  ['scrypt', 16384, 8, 1, salt.toString('base64'), scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')].join('$');
const verify = (pw: string, stored: string) => hash(pw, Buffer.from(stored.split('$')[4]!, 'base64')) === stored;
const role = (r: string) => admin.unsafe(`do $$ begin if not exists (select from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);

async function createDb(name: string, owner: string) {
  await role(owner);
  await admin.unsafe(`drop database if exists ${name}`);
  await admin.unsafe(`create database ${name} owner ${owner}`);
  dbs.push(name);
}

type Platform = Pick<MoveOptions, 'deviations' | 'identity'>;
/** A platform server's deviations and identity databases, as after install and apply with Deviations licensed. */
async function platform(t: string): Promise<Platform> {
  const db = tag(t);
  await createDb(db, `${db}_owner`);
  await admin.unsafe(`revoke all on database ${db} from public`);
  await admin.unsafe(`grant connect, temporary on database ${db} to ${APP_ROLE}`);
  const deviations = conn(db);
  const init = readFileSync(path.join(fixtures, 'database.sql'), 'utf8').replace(/^(begin|commit);$/gm, '')
    .replaceAll(':"owner"', `"${db}_owner"`).replaceAll(":'owner'", `'${db}_owner'`).replaceAll(':"app"', `"${APP_ROLE}"`)
    .replaceAll(":'app'", `'${APP_ROLE}'`).replaceAll(':"db"', `"${db}"`).replaceAll(":'db'", `'${db}'`);
  await deviations.begin((tx) => tx.unsafe(init));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{4}_[a-z0-9_]+\.sql$/.test(x)).sort())
    await deviations.begin(async (tx) => { await tx.unsafe(`set local role ${db}_owner`); await tx.unsafe(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')); });
  // Apply starts the app, which checks integrity once at its first start and audits it (server/integrity.ts).
  await runIntegrityCheck(deviations);

  await role('core_app');
  await createDb(`${db}_identity`, `${db}_owner`);
  const identity = conn(`${db}_identity`);
  await identity`create schema report`;
  for (const f of readdirSync(path.join(fixtures, 'identity')).sort()) await identity.unsafe(readFileSync(path.join(fixtures, 'identity', f), 'utf8'));
  // The installer's first administrator, and apply loading Deviations' permission list from its manifest.
  const [me] = await identity<{ id: string }[]>`insert into employee (login, identity_verified_by, identity_verified_how)
    values ('platform.admin', 'Installer', 'Passport seen') returning id`;
  await identity`insert into employee_version (employee_id, version, full_name, active, changed_by_name, reason)
    values (${me!.id}, 1, 'Platform Admin', true, 'installer', 'first administrator')`;
  for (const [code, label] of Object.entries(PERMISSIONS))
    await identity`insert into permission_event (product, code, label, active, by_name, reason) values ('deviations', ${code}, ${label}, true, 'apply', 'licence')`;
  return { deviations, identity };
}

// A person core already has (moved with the Logbook or MMS), with the codes given there.
async function corePerson(p: Platform, login: string, codes: string[]) {
  const [me] = await p.identity<{ id: string }[]>`select id from employee where login = 'platform.admin'`;
  const [e] = await p.identity<{ id: string }[]>`insert into employee (login, identity_verified_by, identity_verified_how)
    values (${login}, 'Logbook move', 'ID card') returning id`;
  await p.identity`insert into employee_version (employee_id, version, full_name, active, changed_by, changed_by_name, reason)
    values (${e!.id}, 1, ${`${login} in core`}, true, ${me!.id}, 'Platform Admin', 'Logbook move')`;
  await p.identity`insert into credential (employee_id, password_hash, must_change) values (${e!.id}, ${hash('Core-pass-1')}, false)`;
  for (const c of codes) await p.identity`insert into permission_grant (employee_id, product, code, granted, by_name, reason)
    values (${e!.id}, ${c.split('.')[0]!}, ${c}, true, 'Platform Admin', 'given by hand')`;
  return e!.id;
}

const opts = { by: 'platform.admin', verifiedBy: 'Site HR (Anita Rao)', verifiedHow: 'Employee ID card checked at hiring (SOP-HR-003)' };
const schema = `devmvsrc_${process.pid}`;
let source: Sql;
let section: { id: number; data: object };

beforeAll(async () => {
  admin = connect(url('postgres'));
  await role('dev_app');
  // The live site's database: the standalone release (2b49b4a) ran migrations 0001–0010 and had local accounts.
  source = conn(TEST_DATABASE_URL.replace(/^.*\//, ''), { searchPath: schema });
  await source.unsafe(`drop schema if exists ${schema} cascade; drop schema if exists ${schema}_report cascade; create schema ${schema}`);
  await migrate(source, path.join(fixtures, 'standalone'));

  const user = async (login: string, roles: string[], extra: { active?: boolean; locked?: boolean; pw?: string } = {}) => {
    const [u] = await source<{ id: number }[]>`insert into users (username, full_name, password_hash, must_change_password, active, failed_attempts, locked_at)
      values (${login}, ${`${login.toUpperCase()} Name`}, ${hash(extra.pw ?? 'Old-Password-1')}, false, ${extra.active ?? true},
        ${extra.locked ? 5 : 0}, ${extra.locked ? new Date() : null}) returning id::int`;
    for (const r of roles) await source`insert into user_roles (user_id, role) values (${u!.id}, ${r})`;
    return u!.id;
  };
  const adminId = await user('admin1', ['admin']);
  const qa = await user('qa1', ['qa', 'user'], { pw: 'Qa1-Secret-pass' });
  const us = await user('us1', ['user']);
  await user('1ravi', ['user'], { pw: 'Ravi-Secret-1' });   // core logins start with a letter
  await user('qa.old', ['qa'], { active: false });
  await user('us.locked', ['user'], { locked: true });
  const audit = (actor: number, action: string, type: string, id: number | string, v: object) =>
    source`insert into audit_log (actor_id, action, object_type, object_id, new_value) values (${actor}, ${action}, ${type}, ${String(id)}, ${source.json(v as never)})`;

  await source`update settings set site_name = 'Plant 1 (live)', target_days_major = 45`;
  const [area] = await source<{ id: number }[]>`insert into areas (name) values ('Sterile filling') returning id::int`;
  await source`insert into deviation_types (name, lab_oos) values ('OOS', true)`;
  await audit(adminId, 'area.created', 'area', area!.id, { name: 'Sterile filling' });

  // A deviation with report (corrected once), classification and a signed investigation; batches, an attachment, a fetch.
  const [dev] = await source<{ id: number }[]>`insert into deviations (year, seq, number, planned, reporter_id, step, classification, target_date, investigator_id)
    values (2026, 1, 'DEV-26-001', false, ${us}, 'closure', 'major', '2026-12-01', ${us}) returning id::int`;
  const sect = async (kind: string, version: number, data: object, by: number, supersedes: number | null = null) =>
    (await source<{ id: number }[]>`insert into sections (deviation_id, kind, version, data, saved_by, reason, supersedes)
      values (${dev!.id}, ${kind}, ${version}, ${source.json(data as never)}, ${by}, ${version > 1 ? 'clarified' : null}, ${supersedes}) returning id::int`)[0]!.id;
  const r1 = await sect('report', 1, { title: 'Filter integrity failed', areaId: area!.id }, us);
  const r2 = await sect('report', 2, { title: 'Filter integrity test failed', areaId: area!.id }, us, r1);
  await sect('classification', 1, { classification: 'major', investigatorId: us }, qa);
  const invData = { rootCause: 'Wrong filter', conclusion: 'Batch not affected', price: 1.1 };
  const inv = await sect('investigation', 1, invData, us);
  section = { id: inv, data: invData };
  await source`insert into batches (section_id, deviation_id, role, product, batch, batch_norm) values (${r2}, ${dev!.id}, 'own', 'Ondansetron inj', 'OND-5', 'ond5')`;
  await source`insert into batches (section_id, deviation_id, role, product, batch, batch_norm, outcome) values (${inv}, ${dev!.id}, 'other', 'Ondansetron inj', 'OND-6', 'ond6', 'not_affected')`;
  const sign = async (type: 'section' | 'capa', id: number, by: number, meaning: string, content: unknown) => {
    const h = contentHash(type, id, content);
    const [g] = await source<{ id: number }[]>`insert into signatures (object_type, object_id, user_id, printed_name, meaning, content_hash)
      values (${type}, ${id}, ${by}, 'Signer', ${meaning}, ${h}) returning id::int`;
    await audit(by, `signed.${meaning}`, type === 'capa' ? 'capa_version' : type, id, { signatureId: g!.id, contentHash: h });
  };
  await sign('section', inv, us, 'investigation_complete', invData);
  const file = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a]);
  const sha = createHash('sha256').update(file).digest('hex');
  const [att] = await source<{ id: number }[]>`insert into attachments (deviation_id, filename, mime, size, sha256, data, uploaded_by)
    values (${dev!.id}, 'chart.pdf', 'application/pdf', ${file.length}, ${sha}, ${file}, ${us}) returning id::int`;
  await audit(us, 'attachment.added', 'attachment', att!.id, { attachmentId: att!.id, sha256: sha });
  const [fetch] = await source<{ id: number; sha256: string }[]>`
    insert into data_fetches (deviation_id, source, status, params, views, data, row_count, sha256, fetched_by)
    select ${dev!.id}, 'logbook', 'ok', ${source.json({ equipment: 'FIL-01' })}, ${source.json(['entry_v1'])}, d, 1,
      encode(sha256(convert_to(d::text, 'UTF8')), 'hex'), ${us}
    from (select ${source.json({ rows: [{ at: '2026-10-01T08:00:00Z', note: 'Ünïcode ✓', value: 12.5 }] })}::jsonb as d) x returning id::int, sha256`;
  await audit(us, 'data.fetched', 'data_fetch', fetch!.id, { fetchId: fetch!.id, sha256: fetch!.sha256 });

  // A CAPA from the deviation, done and verified; and one from an audit, open.
  await source`insert into capas (year, seq, number, source, deviation_id, owner_id, due_date, raised_by, step, check_due)
    values (2026, 1, 'CAPA-26-001', 'deviation', ${dev!.id}, ${us}, '2026-11-30', ${qa}, 'check', '2027-02-01')`;
  await source`insert into capas (year, seq, number, source, source_ref, owner_id, due_date, raised_by)
    values (2026, 2, 'CAPA-26-002', 'audit', 'AUD-7', ${us}, '2027-01-15', ${qa})`;
  const ver = async (capa: string, version: number, action: string, data: object, by: number) =>
    (await source<{ id: number }[]>`insert into capa_versions (capa_id, version, action, data, saved_by)
      select id, ${version}, ${action}, ${source.json(data as never)}, ${by} from capas where number = ${capa} returning id::int`)[0]!.id;
  await ver('CAPA-26-001', 1, 'raised', { description: 'Replace filter supplier', type: 'corrective' }, qa);
  await ver('CAPA-26-001', 2, 'done', { description: 'Replace filter supplier', note: 'done' }, us);
  const verified = { description: 'Replace filter supplier', effectiveness: { mode: 'trend' } };
  const v3 = await ver('CAPA-26-001', 3, 'verified', verified, qa);
  await sign('capa', v3, qa, 'verified', verified);
  await ver('CAPA-26-002', 1, 'raised', { description: 'Train operators' }, qa);
  await source`insert into alerts (kind, user_id, message) values ('locked', ${us}, 'Account locked')`;
  await source`insert into sessions (id, user_id) values ('old-session', ${us})`;
}, 60_000);

afterAll(async () => {
  await Promise.all(open.map((s) => s.end()));
  const test = connect(TEST_DATABASE_URL);
  await test.unsafe(`drop schema if exists ${schema} cascade; drop schema if exists ${schema}_report cascade`);
  await test.end();
  for (const d of dbs.reverse()) await admin.unsafe(`drop database if exists ${d}`);
  for (const t of ['live', 'refused', 'rollback']) await admin.unsafe(`drop role if exists ${tag(t)}_owner`);
  await admin.end();
});

const codes = async (p: Platform, login: string) => (await p.identity<{ code: string }[]>`
  select g.code from current_permission_grant g join employee e on e.id = g.employee_id where e.login = ${login} order by 1`).map((x) => x.code);

describe('the move of the standalone Deviations (slice 5)', () => {
  let target: Platform;
  let moved: MoveResult;
  const count = async (p: Platform) => [(await p.identity`select count(*)::int as n from employee`)[0]!.n,
    (await p.identity`select count(*)::int as n from permission_grant`)[0]!.n,
    (await p.deviations`select count(*)::int as n from audit_log`)[0]!.n, (await p.deviations`select count(*)::int as n from users`)[0]!.n];

  beforeAll(async () => {
    target = await platform('live');
    // The Logbook moved first: core already has us1 (one Deviations code given by hand) and qa.old, the same people.
    await corePerson(target, 'us1', ['deviations.capa.complete']);
    await corePerson(target, 'qa.old', ['core.masterdata.view']);
  }, 120_000);

  it('PL-13 a login core already has is refused unless the site confirms it, then linked', async () => {
    const r = await moveToPlatform({ source, ...target, ...opts, dryRun: true });
    expect(r.problems).toEqual(['login us1 already exists in core; link it only if the site confirms (--link)',
      'login qa.old already exists in core; link it only if the site confirms (--link)']);
    const wrong = await moveToPlatform({ source, ...target, ...opts, link: ['us1', 'qa.old', 'ghost', 'platform.admin'], dryRun: true });
    expect(wrong.problems).toEqual(['--link ghost: core has no such login', '--link platform.admin: Deviations has no such login to move']);
  });

  it('PL-13 dry run writes nothing and lists the plan', async () => {
    const was = await count(target);
    const r = await moveToPlatform({ source, ...target, ...opts, link: ['us1', 'qa.old'], dryRun: true });
    expect(r).toMatchObject({ moved: false, problems: [] });
    expect(await count(target)).toEqual(was);
    expect(await target.deviations`select 1 from sections`).toEqual([]);
    const csv = reportCsv(r);
    // The source is named first, so the operator sees it is the live site and not the demo.
    expect(csv.split('\r\n').slice(1, 3)).toEqual(['"source","site_name","Plant 1 (live)","","settings.site_name of the source"',
      '"source","deviations","1","","deviations in the source"']);
    expect(csv).toContain('planned: linked to existing core person (site-confirmed); codes deviations.capa.complete deviations.deviation.report deviations.investigation.write');
    expect(csv).toContain('"user","1","admin1","","planned: codes core.people.manage deviations.audit.read deviations.settings.manage"');
    expect(csv).toContain('"user","6","us.locked","","planned: granted nothing: locked in Deviations"');
  });

  it('PL-13 moves every row with equal counts and checksums and maps every person', async () => {
    const r = moved = await moveToPlatform({ source, ...target, ...opts, link: ['us1', 'qa.old'] });
    expect(r.problems).toEqual([]);
    expect(r.moved).toBe(true);
    const tables = r.rows.filter((x) => x.type === 'table').map((x) => x.localId).sort();
    expect(tables).toEqual(['alerts', 'areas', 'attachment_withdrawals', 'attachments', 'audit_log', 'batches', 'capa_versions', 'capas',
      'data_fetches', 'deviation_types', 'deviations', 'sections', 'settings', 'signatures', 'user_roles', 'users']);
    expect(await target.deviations`select 1 from sessions union all select 1 from signing_proofs`).toEqual([]);
    // The platform app's own startup integrity row on the empty database is listed, then removed before the copy.
    expect(r.rows).toContainEqual(expect.objectContaining({ type: 'removed', localId: 'audit_log',
      note: expect.stringContaining("the platform app's own startup integrity check on the empty database") }));
    expect(await target.deviations`select site_name, target_days_major from settings`).toEqual([{ site_name: 'Plant 1 (live)', target_days_major: 45 }]);
    expect((await target.deviations`select data from attachments`)[0]!.data).toEqual((await source`select data from attachments`)[0]!.data);
    expect(await target.deviations`select data from data_fetches`).toEqual(await source`select data from data_fetches`);
    expect(await target.deviations`select username from users where employee_id is null`).toEqual([]);
    // Ids continue after the moved ones.
    const seq = async (q: Sql) => q`select (select last_value from users_id_seq) as u, (select last_value from sections_id_seq) as s, (select last_value from audit_log_id_seq) as a`;
    expect(await seq(target.deviations)).toEqual(await seq(source));
    expect(Number((await target.deviations`select nextval('sections_id_seq') as n`)[0]!.n)).toBe(5);
    // The app's integrity check passes, and the move wrote no audit row of its own (the copied rows are the source's).
    expect(await check(target.deviations)).toMatchObject({ problems: [], sections: 4, capaVersions: 4, signatures: 2, attachments: 1, dataFetches: 1 });
    expect((await target.deviations`select count(*)::int as n from audit_log`)[0]!.n).toBe((await source`select count(*)::int as n from audit_log`)[0]!.n);
  });

  it('PL-13 a moved person signs on with the same password and holds the codes of their old roles', async () => {
    const [qa] = await target.identity<{ id: string; password_hash: string; identity_verified_by: string; identity_verified_how: string; full_name: string }[]>`
      select e.id, c.password_hash, e.identity_verified_by, e.identity_verified_how, e.full_name
      from employee_current e join credential c on c.employee_id = e.id where e.login = 'qa1'`;
    expect(qa!.password_hash).toBe((await source`select password_hash from users where username = 'qa1'`)[0]!.password_hash);
    expect(verify('Qa1-Secret-pass', qa!.password_hash)).toBe(true);
    expect(qa).toMatchObject({ identity_verified_by: opts.verifiedBy, identity_verified_how: opts.verifiedHow, full_name: 'QA1 Name' });
    expect((await target.deviations`select employee_id::text from users where username = 'qa1'`)[0]!.employee_id).toBe(qa!.id);
    expect(await codes(target, 'qa1')).toEqual([...ROLE_PERMISSIONS.qa].sort());
    expect((await target.identity`select reason from permission_grant g join employee e on e.id = g.employee_id where e.login = 'qa1' limit 1`)[0]!.reason)
      .toBe('Moved from the standalone Deviations & CAPA (slice 5): roles qa, user');
    // Linked: no new person, core's credential untouched, only the codes it lacked.
    const [us] = await target.identity<{ id: string; password_hash: string }[]>`
      select e.id, c.password_hash from employee e join credential c on c.employee_id = e.id where e.login = 'us1'`;
    expect(verify('Core-pass-1', us!.password_hash)).toBe(true);
    expect((await target.deviations`select employee_id::text from users where username = 'us1'`)[0]!.employee_id).toBe(us!.id);
    expect(await codes(target, 'us1')).toEqual([...ROLE_PERMISSIONS.user].sort());
    expect(moved.rows).toContainEqual({ type: 'user', localId: '3', code: 'us1', employeeId: us!.id,
      note: 'linked to existing core person (site-confirmed); granted deviations.deviation.report deviations.investigation.write' });
  });

  it('PL-13 admins also get core.people.manage', async () => {
    expect(await codes(target, 'admin1')).toEqual([...ROLE_PERMISSIONS.admin, 'core.people.manage'].sort());
  });

  it('PL-13 a person deactivated or locked in Deviations gets no codes, also when linked', async () => {
    // qa.old: deactivated, linked to an active core person, who keeps only what core gave them.
    expect(await codes(target, 'qa.old')).toEqual(['core.masterdata.view']);
    expect(moved.rows).toContainEqual(expect.objectContaining({ code: 'qa.old',
      note: 'linked to existing core person (site-confirmed); granted nothing: deactivated in Deviations' }));
    // us.locked: created in core, locked there too, with no codes.
    expect(await codes(target, 'us.locked')).toEqual([]);
    const [c] = await target.identity<{ locked: boolean; failed_count: number; active: boolean }[]>`
      select c.locked_at is not null as locked, c.failed_count, e.active from employee_current e join credential c on c.employee_id = e.id where e.login = 'us.locked'`;
    expect(c).toEqual({ locked: true, failed_count: 5, active: true });
    expect(moved.rows).toContainEqual(expect.objectContaining({ code: 'us.locked', note: 'granted nothing: locked in Deviations' }));
  });

  it('PL-13 a login starting with a digit gets a u prefix', async () => {
    const [e] = await target.identity<{ id: string; password_hash: string }[]>`
      select e.id, c.password_hash from employee e join credential c on c.employee_id = e.id where e.login = 'u1ravi'`;
    expect(verify('Ravi-Secret-1', e!.password_hash)).toBe(true);
    expect(await target.deviations`select username, employee_id::text from users where employee_id = ${e!.id}`).toEqual([{ username: '1ravi', employee_id: e!.id }]);
    expect(moved.rows).toContainEqual(expect.objectContaining({ code: '1ravi', note: expect.stringContaining('(core login u1ravi: Deviations login 1ravi starts with a digit)') }));
  });

  it('DV-08 capa_v1 reads the same rows after the move', async () => {
    const read = (q: Sql, s: string) => q.unsafe(`select number, status, due_date, deviation_number, description, source, data_as_of from ${s}.capa_v1 order by number`);
    const after = await read(target.deviations, 'report');
    expect(after.length).toBe(2);
    expect(after).toEqual(await read(source, `${schema}_report`));
  });

  it('PL-13 a second run is refused: the platform database is no longer empty', async () => {
    const r = await moveToPlatform({ source, ...target, ...opts, by: 'nobody' });
    expect(r.moved).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining(['no active core employee with login nobody (--by)', expect.stringMatching(/^table users on the platform is not empty/)]));
  });
});

describe('a move that must stop (slice 5)', () => {
  const count = async (p: Platform) => [(await p.identity`select count(*)::int as n from employee`)[0]!.n,
    (await p.identity`select count(*)::int as n from permission_grant`)[0]!.n, (await p.deviations`select count(*)::int as n from users`)[0]!.n,
    (await p.deviations`select site_name from settings`)[0]!.site_name];

  it('PL-13 a login core refuses even with the prefix stops the move and is listed', async () => {
    const p = await platform('refused');
    const [u] = await source<{ id: number }[]>`insert into users (username, full_name, password_hash, must_change_password)
      values ('-tmp', 'Temp', ${hash('Tmp-pass-1')}, false) returning id::int`;
    try {
      const r = await moveToPlatform({ source, ...p, ...opts });
      expect(r.moved).toBe(false);
      expect(r.problems).toContain('login -tmp: login does not fit core\'s rule (a letter first, 2 to 40 characters)');
      expect(reportCsv(r)).toContain(`"user","${u!.id}","-tmp","","refused: login does not fit core's rule (a letter first, 2 to 40 characters)"`);
    } finally {
      await source`delete from users where id = ${u!.id}`;
    }
  }, 120_000);

  it('PL-13 a person deactivated in Deviations whose linked core person already holds a Deviations code stops the move, found by the dry run', async () => {
    const p = await platform('blockedheld');
    await corePerson(p, 'qa.old', ['deviations.deviation.report']);
    const r = await moveToPlatform({ source, ...p, ...opts, link: ['qa.old'], dryRun: true });
    expect(r.problems).toContain('--link qa.old: deactivated in Deviations, but core already grants deviations.deviation.report; take these away in core first');
  }, 120_000);

  it('PL-13 codes core already grants a linked person beyond their old roles stay and are listed on the report', async () => {
    const p = await platform('extra');
    await corePerson(p, 'us1', ['deviations.deviation.close']);
    const r = await moveToPlatform({ source, ...p, ...opts, link: ['us1'], dryRun: true });
    expect(r.rows).toContainEqual(expect.objectContaining({ code: 'us1',
      note: expect.stringContaining('core already grants beyond the old roles: deviations.deviation.close (kept, given in core)') }));
  }, 120_000);

  it('PL-13 the source must be read as a superuser, so that no table is skipped', async () => {
    const p = await platform('notsuper');
    const weak = conn(TEST_DATABASE_URL.replace(/^.*\//, ''), { searchPath: schema, role: 'dev_app' });
    try {
      const r = await moveToPlatform({ source: weak, ...p, ...opts, dryRun: true });
      expect(r.problems).toContain('the source must be read as a superuser (SOURCE_DATABASE_URL), so that no table is skipped');
    } finally {
      await weak.end();
    }
  }, 120_000);

  it('PL-13 a failed check moves nothing', async () => {
    const p = await platform('rollback');
    const was = await count(p);
    // The investigation was changed behind its signature: the integrity check fails after everything was written.
    await source`update sections set data = ${source.json({ ...section.data, conclusion: 'tampered' } as never)} where id = ${section.id}`;
    try {
      const r = await moveToPlatform({ source, ...p, ...opts });
      expect(r.moved).toBe(false);
      expect(r.problems).toEqual([expect.stringMatching(/^integrity: Signature 1 \(investigation_complete\) on section \d+: content changed after signing/)]);
      expect(r.rows.every((x) => x.type === 'source' || x.note.startsWith('refused'))).toBe(true);
    } finally {
      await source`update sections set data = ${source.json(section.data as never)} where id = ${section.id}`;
    }
    expect(await count(p)).toEqual(was);
    expect(await p.deviations`select 1 from sections`).toEqual([]);
  }, 120_000);
});
