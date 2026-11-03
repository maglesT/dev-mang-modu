// Slice 5 (D-45, platform PL-13): moves the standalone Deviations & CAPA (the `deviations-live` installation) onto the
// Medhanta platform. Adapted from MMS's db/move-to-platform.ts (its B2-5, D-55), without master data: Deviations keeps
// none (D-42). The platform's migrate has already built the schema in its `deviations` database (empty but for the
// settings row of migration 0003, which the site's own replaces). This script copies the rows (data only, so the
// schema and the app login's rights stay exactly as the migrations made them), creates the people in core with the
// same password hashes and their permissions (old roles -> codes, ROLE_PERMISSIONS; admins also core.people.manage),
// and fills the id map users.employee_id. A login core already has is linked only when the site confirmed it (--link).
// A person deactivated or locked in Deviations gets no codes at all, also when linked (lead, D-45).
// Checks (PL-13): row counts and checksums of every table equal before and after, every user mapped or listed as
// refused, the codes in core as expected, the integrity check passes. Both databases commit only if all pass.
// The report starts with the source's site name and deviation count: check they are the live site's, not the demo's.
// Run it with --dry-run first (it writes nothing).
// Usage: SOURCE_DATABASE_URL=<deviations-live database> PLATFORM_DATABASE_URL=postgres://<superuser>@<platform db host>:5432 \
//   node dist/db/move-to-platform.js --by <core login> --verified-by "<who>" --verified-how "<how>" --report move.csv \
//   [--link login1,login2] [--dry-run]
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { connect, type Sql, type Tx } from '../server/db.js';
import { ROLE_PERMISSIONS, type Role } from '../server/auth.js';
import { check as checkIntegrity } from '../server/integrity.js';

// Moved admins also manage people in core (as Logbook D-29 6, MMS D-55 7); no master-data code: Deviations has none.
const ADMIN_CORE = ['core.people.manage'];
// Core's login rule (identity employee.login).
const CORE_LOGIN = /^[a-z][a-z0-9._-]{1,39}$/;
// Not moved: the migration record (the platform keeps its own) and open sessions (everyone signs on again at core).
const SKIP = new Set(['schema_migrations', 'sessions']);
// Migration 0003 seeds the settings row; the move replaces it with the site's own.
const SEEDED = new Set(['settings']);
const REASON = 'Moved from the standalone Deviations & CAPA (slice 5)';
// The id map is filled by the move itself: not copied, not compared.
const MAPPED: Record<string, string[]> = { users: ['employee_id'] };

export interface MoveOptions {
  source: Sql;                 // the standalone Deviations database; read in one snapshot, never written
  deviations: Sql;             // the platform's deviations database as a superuser (triggers stay off while rows are copied)
  identity: Sql;               // core's identity database
  by: string;                  // core login of the person running the move
  verifiedBy: string;          // 21 CFR 11.100(b): who verified each moved person's identity (from the site)
  verifiedHow: string;
  link?: string[];             // core logins the site confirmed are the same person as the Deviations login
  dryRun?: boolean;
}

export interface MoveRow { type: 'source' | 'user' | 'table'; localId: string; code: string; employeeId: string; note: string }
export interface MoveResult { rows: MoveRow[]; problems: string[]; moved: boolean }

interface User { id: number; username: string; full_name: string; password_hash: string; must_change_password: boolean;
  password_changed_at: Date; temp_password_expires_at: Date | null; failed_attempts: number; locked_at: Date | null; active: boolean; roles: Role[] }
interface Mover extends User { login: string; codes: string[]; blocked: string | null; linkTo: string | null }

const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;

async function tables(q: Sql | Tx): Promise<Map<string, string[]>> {
  const rows = await q<{ t: string; c: string }[]>`
    select c.table_name as t, c.column_name as c from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = current_schema() and t.table_type = 'BASE TABLE' order by c.table_name, c.ordinal_position`;
  const m = new Map<string, string[]>();
  for (const r of rows) if (!SKIP.has(r.t) && !MAPPED[r.t]?.includes(r.c)) m.set(r.t, [...(m.get(r.t) ?? []), r.c]);
  return m;
}

// Row count and a checksum over the given columns, independent of row order (PL-13).
async function checksum(q: Sql | Tx, table: string, cols: string[]) {
  const [r] = await q.unsafe<{ n: number; sum: string }[]>(
    `select count(*)::int as n, coalesce(md5(string_agg(h, '' order by h)), '') as sum from (select md5(row(${cols.map(ident).join(', ')})::text) as h from ${ident(table)}) x`);
  return `${r!.n} ${r!.sum}`;
}

// Both ends print values the same way, whatever the database's own settings (the checksums compare text).
const pin = (q: Tx) => q.unsafe(`set local datestyle = 'ISO, YMD'; set local intervalstyle = 'postgres'; set local bytea_output = 'hex';
  set local extra_float_digits = 1; set local timezone = 'UTC'`);

export async function moveToPlatform(o: MoveOptions): Promise<MoveResult> {
  const problems: string[] = [];
  const link = new Set(o.link ?? []);
  return o.source.begin('isolation level repeatable read read only', async (src) => {
    await pin(src);
    // --- Plan (reads only) ---
    // Which installation this is (the server also runs the demo): the report's first rows.
    const [site] = await src<{ name: string; n: number }[]>`select (select site_name from settings) as name, (select count(*)::int from deviations) as n`;
    const head: MoveRow[] = [{ type: 'source', localId: 'site_name', code: site!.name, employeeId: '', note: 'settings.site_name of the source' },
      { type: 'source', localId: 'deviations', code: String(site!.n), employeeId: '', note: 'deviations in the source' }];
    const rows: MoveRow[] = [...head];
    const from = await tables(src);
    const to = await tables(o.deviations);
    const copy: [string, string[]][] = [];
    for (const [t, cols] of from) {
      const target = to.get(t);
      if (!target) { problems.push(`table ${t} is not in the platform's deviations database`); continue; }
      const lost = cols.filter((c) => !target.includes(c));
      if (lost.length) problems.push(`table ${t}: columns ${lost.join(', ')} are not in the platform's deviations database`);
      const [{ n }] = (await o.deviations.unsafe(`select count(*)::int as n from ${ident(t)}`)) as unknown as [{ n: number }];
      if (n > (SEEDED.has(t) ? 1 : 0)) problems.push(`table ${t} on the platform is not empty (${n} rows): the move needs a freshly migrated database`);
      copy.push([t, cols]);
    }

    const [me] = await o.identity<{ id: string; full_name: string }[]>`
      select id, full_name from employee_current where login = ${o.by} and active`;
    if (!me) problems.push(`no active core employee with login ${o.by} (--by)`);
    // information_schema lists only tables the login may use: a weaker login would skip tables silently.
    if (!(await src<{ su: boolean }[]>`select rolsuper as su from pg_roles where rolname = current_user`)[0]?.su)
      problems.push('the source must be read as a superuser (SOURCE_DATABASE_URL), so that no table is skipped');
    if (!o.verifiedBy.trim() || !o.verifiedHow.trim()) problems.push('the identity verification (--verified-by, --verified-how) is required (11.100(b))');

    // People. A login that starts with a digit gets a "u" in front (core needs a letter first, Logbook D-31 2); others
    // that do not fit core's rule are refused and listed. A login core already has is linked only when the site
    // confirmed it (--link).
    const users = await src<User[]>`
      select u.id::int, u.username, u.full_name, u.password_hash, u.must_change_password, u.password_changed_at, u.temp_password_expires_at, u.failed_attempts,
        u.locked_at, u.active, coalesce(array_agg(r.role order by r.role) filter (where r.role is not null), '{}') as roles
      from users u left join user_roles r on r.user_id = u.id group by u.id order by u.id`;
    const known = new Map((await o.identity<{ id: string; login: string }[]>`select id, login from employee`).map((r) => [r.login, r.id]));
    const activeInCore = new Set((await o.identity<{ login: string }[]>`select login from employee_current where active`).map((r) => r.login));
    const catalogue = new Set((await o.identity<{ code: string }[]>`select code from current_permission`).map((r) => r.code));
    const movers: Mover[] = [];
    for (const u of users) {
      const login = /^[0-9]/.test(u.username) ? `u${u.username}` : u.username;
      const refuse = !CORE_LOGIN.test(login) ? 'login does not fit core\'s rule (a letter first, 2 to 40 characters)'
        : !known.has(login) && !u.password_hash.startsWith('scrypt$') ? 'no password hash'
        : null;
      // A refused person could no longer sign on or be traced to core: the site corrects it before the freeze.
      if (refuse) {
        rows.push({ type: 'user', localId: String(u.id), code: u.username, employeeId: '', note: `refused: ${refuse}` });
        problems.push(`login ${u.username}: ${refuse}`);
        continue;
      }
      if (known.has(login) && !link.has(login)) problems.push(`login ${login} already exists in core; link it only if the site confirms (--link)`);
      const blocked = !u.active ? 'deactivated in Deviations' : u.locked_at ? 'locked in Deviations' : null;
      const codes = blocked ? [] : [...new Set(u.roles.flatMap((r) => [...ROLE_PERMISSIONS[r], ...(r === 'admin' ? ADMIN_CORE : [])]))].sort();
      for (const c of codes) if (!catalogue.has(c)) problems.push(`permission ${c} is not in core's catalogue (is Deviations licensed?)`);
      movers.push({ ...u, login, codes, blocked, linkTo: known.get(login) ?? null });
    }
    for (const m of movers) if (movers.find((x) => x.login === m.login) !== m) problems.push(`two Deviations logins become core login ${m.login}`);
    for (const l of link) {
      if (!known.has(l)) problems.push(`--link ${l}: core has no such login`);
      else if (!activeInCore.has(l)) problems.push(`--link ${l}: this core person is not active; reactivate them in core first`);
      else if (!movers.some((m) => m.login === l)) problems.push(`--link ${l}: Deviations has no such login to move`);
    }
    // Someone deactivated or locked here must hold no Deviations code after the move: a linked core person who already
    // holds one is found now (the dry run lists it), not only at the final check.
    // Codes core already grants a linked person beyond their old roles were given in core on purpose: they stay, and
    // the report lists them so the site sees them.
    const extra = new Map<number, string[]>();
    for (const m of movers.filter((x) => x.linkTo)) {
      const held = (await o.identity<{ code: string }[]>`
        select code from current_permission_grant where employee_id = ${m.linkTo} and product = 'deviations' order by code`).map((h) => h.code);
      if (m.blocked && held.length) problems.push(`--link ${m.login}: ${m.blocked}, but core already grants ${held.join(' ')}; take these away in core first`);
      const beyond = held.filter((c) => !m.codes.includes(c));
      if (!m.blocked && beyond.length) extra.set(m.id, beyond);
    }

    const did = (u: Mover, what: string) => (u.linkTo ? `linked to existing core person (site-confirmed); ${what}` : what)
      + (extra.has(u.id) ? `; core already grants beyond the old roles: ${extra.get(u.id)!.join(' ')} (kept, given in core)` : '')
      + (u.login !== u.username ? ` (core login ${u.login}: Deviations login ${u.username} starts with a digit)` : '');
    if (problems.length || o.dryRun) return { rows: [...rows,
      ...movers.map((u): MoveRow => ({ type: 'user', localId: String(u.id), code: u.username, employeeId: u.linkTo ?? '',
        note: `planned: ${did(u, u.blocked ? `granted nothing: ${u.blocked}` : `codes ${u.codes.join(' ')}`)}` }))], problems, moved: false };

    // The whole move is one unit: both platform databases commit only after every check below has passed (the commits
    // follow one another: identity first; a failure between them is reported by the run and leaves the old site live).
    const employee = new Map<number, string>();
    await o.deviations.begin(async (dv) => {
      await pin(dv);
      await dv`set local session_replication_role = replica`;   // as pg_restore --disable-triggers (foreign keys too)
      await o.identity.begin(async (id) => {
        // --- 1. Rows, data only (PL-13). Rows travel as JSON text, never parsed on the way, in small batches. ---
        for (const t of SEEDED) await dv.unsafe(`delete from ${ident(t)}`);
        for (const [t, cols] of copy) {
          const list = cols.map(ident).join(', ');
          const cursor = src.unsafe<{ r: string }[]>(`select row_to_json(x)::text as r from ${ident(t)} x`).cursor(20);
          for await (const batch of cursor)
            await dv.unsafe(`insert into ${ident(t)} (${list}) overriding system value select ${list} from json_populate_recordset(null::${ident(t)}, $1::text::json)`,
              [`[${batch.map((b) => b.r).join(',')}]`]);
          const sum = await checksum(src, t, cols);
          if (await checksum(dv, t, cols) !== sum) throw new Error(`PL-13: table ${t} differs after the copy; nothing was moved`);
          rows.push({ type: 'table', localId: t, code: sum, employeeId: '', note: 'copied, count and checksum equal' });
        }
        // Every sequence (identity columns) continues where the source stopped.
        for (const { s } of await src<{ s: string }[]>`select relname as s from pg_class where relkind = 'S' and relnamespace = current_schema()::regnamespace`) {
          const [v] = (await src.unsafe(`select last_value::text as v, is_called as c from ${ident(s)}`)) as unknown as [{ v: string; c: boolean }];
          await dv`select setval(${ident(s)}::regclass, ${v.v}::bigint, ${v.c})`;
        }

        // --- 2. People and permissions in core ---
        for (const u of movers) {
          let eid = u.linkTo;
          let grant = u.codes;
          let note: string;
          if (eid) {
            // Site-confirmed: the same person; their credential and identity record stay as core has them.
            const held = new Set((await id<{ code: string }[]>`select code from current_permission_grant where employee_id = ${eid}`).map((r) => r.code));
            grant = u.codes.filter((c) => !held.has(c));
            note = did(u, u.blocked ? `granted nothing: ${u.blocked}` : `granted ${grant.join(' ') || 'nothing new'}`);
          } else {
            const [e] = await id<{ id: string }[]>`insert into employee (login, identity_verified_by, identity_verified_how)
              values (${u.login}, ${o.verifiedBy}, ${o.verifiedHow}) returning id`;
            eid = e!.id;
            await id`insert into employee_version (employee_id, version, full_name, email, active, changed_by, changed_by_name, reason)
              values (${eid}, 1, ${u.full_name}, null, ${u.active}, ${me!.id}, ${me!.full_name}, ${REASON})`;
            // A temporary password that had expired stays unusable: core's administrator gives a new one.
            const expired = u.must_change_password && u.temp_password_expires_at !== null && u.temp_password_expires_at < new Date();
            await id`insert into credential (employee_id, password_hash, must_change, changed_at, failed_count, locked_at)
              values (${eid}, ${expired ? 'expired-temporary-password' : u.password_hash}, ${expired || u.must_change_password},
                      ${u.password_changed_at}, ${u.failed_attempts}, ${u.locked_at})`;
            note = did(u, (u.blocked ? `granted nothing: ${u.blocked}` : u.codes.join(' ')) + (expired ? ' (temporary password had expired: reset it in core)' : ''));
          }
          for (const code of grant)
            await id`insert into permission_grant (employee_id, product, code, granted, by_id, by_name, reason)
              values (${eid}, ${code.split('.')[0]!}, ${code}, true, ${me!.id}, ${me!.full_name}, ${`${REASON}: roles ${u.roles.join(', ')}`})`;
          employee.set(u.id, eid);
          rows.push({ type: 'user', localId: String(u.id), code: u.username, employeeId: eid, note });
        }

        // --- 3. The id map ---
        for (const [uid, e] of employee) await dv`update users set employee_id = ${e} where id = ${uid}`;

        // --- 4. Checks (PL-13); any problem rolls both databases back ---
        for (const [t, cols] of copy)
          if (await checksum(dv, t, cols) !== await checksum(src, t, cols)) problems.push(`table ${t} differs from the source after the move`);
        const refused = users.filter((u) => !employee.has(u.id)).map((u) => u.id);
        const unmapped = await dv<{ username: string }[]>`
          select username from users where employee_id is null and not (id = any(${refused}::bigint[]))`;
        problems.push(...unmapped.map((u) => `user ${u.username} is not mapped`));
        const held = await id<{ employee_id: string; code: string }[]>`
          select employee_id, code from current_permission_grant where employee_id = any(${[...employee.values()]}::uuid[])`;
        for (const u of movers) {
          const got = held.filter((h) => h.employee_id === employee.get(u.id)).map((h) => h.code).sort();
          // Blocked: no Deviations code at all (a linked person keeps what core gave them for other products).
          const ok = u.blocked ? !got.some((c) => c.startsWith('deviations.'))
            : u.linkTo ? u.codes.every((c) => got.includes(c)) : got.join() === u.codes.join();
          if (!ok) problems.push(`user ${u.username}: core holds ${got.join(' ') || 'nothing'}, expected ${u.blocked ? 'no Deviations code' : `${u.linkTo ? 'at least ' : ''}${u.codes.join(' ')}`}`);
        }
        await dv`set local session_replication_role = origin`;
        const integrity = await checkIntegrity(dv as unknown as Sql);
        problems.push(...integrity.problems.map((p) => `integrity: ${p}`));
        if (problems.length) throw new Rollback();
      });
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
    // Rolled back: only the source rows and the planned refusals are true.
    return problems.length ? { rows: rows.filter((r) => r.type === 'source' || r.note.startsWith('refused')), problems, moved: false } : { rows, problems, moved: true };
  });
}

class Rollback extends Error {}

export function reportCsv(r: MoveResult): string {
  const cell = (v: string) => `"${v.replaceAll('"', '""')}"`;
  return [['type', 'local_id', 'login_or_value', 'employee_id', 'note'], ...r.rows.map((x) => [x.type, x.localId, x.code, x.employeeId, x.note]),
    ...r.problems.map((p) => ['problem', '', '', '', p])].map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values: a } = parseArgs({ options: {
    by: { type: 'string' }, 'verified-by': { type: 'string' }, 'verified-how': { type: 'string' }, report: { type: 'string' },
    link: { type: 'string' }, 'dry-run': { type: 'boolean' },
  } });
  const source = process.env.SOURCE_DATABASE_URL;
  const platform = process.env.PLATFORM_DATABASE_URL?.replace(/\/+$/, '');
  if (!source || !platform || !a.by || !a.report) throw new Error('SOURCE_DATABASE_URL, PLATFORM_DATABASE_URL, --by and --report are required');
  const o = { source: connect(source), deviations: connect(`${platform}/deviations`), identity: connect(`${platform}/identity`) };
  try {
    const r = await moveToPlatform({ ...o, by: a.by, verifiedBy: a['verified-by'] ?? '', verifiedHow: a['verified-how'] ?? '',
      link: (a.link ?? '').split(',').map((s) => s.trim()).filter(Boolean), dryRun: a['dry-run'] })
      .catch((e: unknown): MoveResult => ({ rows: [], moved: false, problems: [`the move stopped: ${(e as Error).message}. identity may `
        + 'already have committed: restore both platform databases from the pre-move snapshot before running it again'] }));
    writeFileSync(a.report, reportCsv(r));
    console.log(`${r.moved ? 'moved' : a['dry-run'] ? 'dry run' : 'not moved'}: source "${r.rows[0]?.code ?? '?'}" with ${r.rows[1]?.code ?? '?'} deviations; `
      + `${r.rows.length} rows in ${a.report}, ${r.problems.length} problems`);
    for (const p of r.problems) console.log(`  ${p}`);
    process.exitCode = r.problems.length ? 1 : 0;
  } finally {
    await Promise.all(Object.values(o).map((s) => s.end()));
  }
}
