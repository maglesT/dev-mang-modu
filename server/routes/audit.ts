import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { requireRole } from '../auth.js';

export interface AuditRow {
  id: number;
  at: Date;
  actor: string | null;
  actorUsername: string | null;
  subject: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
}

// DV-15, CP-10: QA and Admin read the audit trail; filters by object, user and time. At most the latest
// AUDIT_LIMIT rows are returned; the screen says so and asks for a narrower period.
export const AUDIT_LIMIT = 1000;
export function auditRoutes(app: FastifyInstance, sql: Sql) {
  app.get<{ Querystring: Record<string, string> }>('/api/audit', { preHandler: requireRole('qa', 'admin') }, async (req, reply) => {
    const f = z
      .object({
        objectType: z.string().max(40).optional(),
        objectId: z.string().max(60).optional(),
        user: z.string().max(40).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .safeParse(req.query);
    if (!f.success) return reply.code(400).send({ error: 'invalid_request' });
    const { objectType, objectId, user, from, to } = f.data;
    return sql<AuditRow[]>`
      select a.id::int, a.at, u.full_name as actor, u.username as "actorUsername", a.action, a.object_type as "objectType",
        a.object_id as "objectId", a.old_value as "oldValue", a.new_value as "newValue", a.reason,
        -- User records are shown by their user ID (unique, never reused), not the internal number.
        case when a.object_type = 'user' then coalesce(t.username, a.object_id) end as subject
      from audit_log a left join users u on u.id = a.actor_id
      left join users t on a.object_type = 'user' and a.object_id ~ '^[0-9]+$' and t.id = a.object_id::bigint
      where ${objectType ? sql`a.object_type = ${objectType}` : sql`true`}
        and ${objectId ? sql`a.object_id = ${objectId}` : sql`true`}
        and ${user
          ? sql`(a.actor_id = (select id from users where username = ${user.toLowerCase()})
                 or (a.object_type = 'user' and (a.object_id = ${user.toLowerCase()}
                     or a.object_id = (select id::text from users where username = ${user.toLowerCase()}))))`
          : sql`true`}
        and ${from ? sql`a.at >= ${from}` : sql`true`}
        and ${to ? sql`a.at < ${to}` : sql`true`}
      order by a.at desc, a.id desc limit ${AUDIT_LIMIT}`;
  });
}
