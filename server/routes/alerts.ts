import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';

// DV-22: a failed integrity check stays on screen for holders of deviations.audit.read until acknowledged. Misuse
// alerts (lockouts) are core's since D-43 (PL-04).
export function alertRoutes(app: FastifyInstance, sql: Sql) {
  const watchers = { preHandler: requirePermission('deviations.audit.read') };

  app.get('/api/alerts', watchers, async () =>
    sql`select id::int, kind, message, created_at as "createdAt"
        from alerts where acknowledged_at is null order by created_at`,
  );

  app.post<{ Params: { id: string } }>('/api/alerts/:id/ack', watchers, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const ok = await sql.begin(async (tx) => {
      const [a] = await tx`update alerts set acknowledged_by = ${req.user!.id}, acknowledged_at = now()
                           where id = ${id} and acknowledged_at is null returning id`;
      if (!a) return false;
      await audit(tx, { actorId: req.user!.id, action: 'alert.acknowledged', objectType: 'alert', objectId: id });
      return true;
    });
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
