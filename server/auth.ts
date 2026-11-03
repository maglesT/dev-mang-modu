import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Sql } from './db.js';
import type { SignOn } from './signon.js';

// D-43 (platform A10, D-42): rights are this product's permission codes from core's token, one code per action group
// (owner-approved list, docs/08-platform-move-plan.md). Reading needs any Deviations code.
export const PERMISSIONS = {
  'deviations.deviation.report': 'Report deviations and correct your own reports',
  'deviations.deviation.classify': 'Classify, assign the investigator, set and change target dates',
  'deviations.deviation.approve': 'Approve or reject planned deviations (e-signature)',
  'deviations.investigation.write': 'Investigate deviations assigned to you, attachments, fetch related data, AI suggestions',
  'deviations.qa.oversee': "Act on any deviation's investigation, report, attachments or CAPA, not only your own; QA to-do lists",
  'deviations.deviation.close': 'Close and reopen deviations (e-signature)',
  'deviations.capa.raise': 'Raise CAPAs, correct them, change due dates',
  'deviations.capa.complete': 'Mark CAPAs you own as done',
  'deviations.capa.verify': 'Verify CAPAs and record effectiveness checks (e-signature)',
  'deviations.audit.read': 'Read the audit trail, run the integrity check',
  'deviations.settings.manage': 'Edit site settings, areas and deviation types',
} as const;
export type Permission = keyof typeof PERMISSIONS;
const CODES = Object.keys(PERMISSIONS) as Permission[];

// The old roles (D-08) and the codes each gives (D-42); used for the data move (slice 5) and by the test stand-ins.
export const ROLES = ['user', 'qa', 'admin'] as const;
export type Role = (typeof ROLES)[number];
const USER: Permission[] = ['deviations.deviation.report', 'deviations.investigation.write', 'deviations.capa.complete'];
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  user: USER,
  qa: [...USER, 'deviations.deviation.classify', 'deviations.deviation.approve', 'deviations.qa.oversee', 'deviations.deviation.close',
    'deviations.capa.raise', 'deviations.capa.verify', 'deviations.audit.read'],
  admin: ['deviations.audit.read', 'deviations.settings.manage'],
};
export const permissionsOf = (roles: readonly Role[]): Permission[] =>
  CODES.filter((c) => roles.some((r) => ROLE_PERMISSIONS[r].includes(c)));

// Only this product's known codes count; anything else in the claim is ignored.
export const asPermissions = (codes: readonly string[]): Permission[] => CODES.filter((c) => codes.includes(c));

export const can = (user: { permissions: readonly string[] }, code: Permission) => user.permissions.includes(code);

// Product defaults (register DV-18); not regulatory numbers. Passwords, their ageing and lockout are core's (D-43).
export const POLICY = {
  sessionIdleMinutes: 15,
  // A session's codes are renewed from core at least this often, so a revoked right or a deactivated person is out
  // within this time (platform PL-01).
  permissionCheckMinutes: 5,
};

// Background polls send this header; they must not keep an idle session alive.
export const BACKGROUND_HEADER = 'x-background-poll';

export const SESSION_COOKIE = 'sid';

export interface SessionUser {
  id: number;
  username: string;
  fullName: string;
  permissions: Permission[];
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

// Only a hash of the session id is stored, so reading the table does not reveal live sessions.
export function sessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('base64url');
}

// Strict positive integer for :id route parameters.
export function parseId(raw: string): number | null {
  return /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null;
}

// Loads the session and enforces the idle timeout; user-initiated requests refresh last_seen_at. Codes older than
// POLICY.permissionCheckMinutes are renewed from core first; if core refuses, the session ends (PL-01).
export async function loadSession(sql: Sql, signOn: SignOn, sessionId: string, touch = true): Promise<SessionUser | null> {
  const key = sessionKey(sessionId);
  // An ended session keeps only its ID token, so a later logout can still end core's session (shared terminals).
  const end = async () => {
    await sql`update sessions set permissions = '{}', refresh_token = null, last_seen_at = '-infinity' where id = ${key}`;
    return null;
  };
  // One request claims a due renewal (others go on with the current codes); core is called outside any transaction.
  const [due] = await sql<{ refresh_token: string | null }[]>`
    update sessions set checked_at = now()
    where id = ${key} and checked_at < now() - make_interval(mins => ${POLICY.permissionCheckMinutes})
      and last_seen_at > now() - make_interval(mins => ${POLICY.sessionIdleMinutes})
    returning refresh_token`;
  if (due) {
    try {
      const id = await signOn.refresh(due.refresh_token ?? '');
      await sql`update sessions set permissions = ${asPermissions(id.permissions)}, refresh_token = coalesce(${id.refreshToken ?? null}, refresh_token),
                  id_token = coalesce(${id.idToken ?? null}, id_token)
                where id = ${key}`;
    } catch {
      return end();
    }
  }
  const [row] = await sql<{ id: number; username: string; full_name: string; permissions: string[] }[]>`
    update sessions s set last_seen_at = case when ${touch} then now() else s.last_seen_at end
    from users u
    where s.id = ${key} and u.id = s.user_id
      and s.last_seen_at > now() - make_interval(mins => ${POLICY.sessionIdleMinutes})
    returning u.id::int as id, u.username, u.full_name, s.permissions`;
  const permissions = asPermissions(row?.permissions ?? []);
  if (!row || !permissions.length) return end();
  return { id: row.id, username: row.username, fullName: row.full_name, permissions, sessionId };
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const user = req.user;
  if (!user) {
    void reply.code(401).send({ error: 'not_logged_in' });
    return null;
  }
  return user;
}

// DV-18: authority check per action, on the server: the session must hold one of the codes (none given: any
// Deviations code). The Admin block is gone: each action needs its own code (D-43, as Logbook D-30, MMS D-55).
export function requirePermission(...codes: Permission[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    if (codes.length && !codes.some((c) => user.permissions.includes(c))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}
