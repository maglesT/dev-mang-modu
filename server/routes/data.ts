import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db.js';
import { parseId, requireRole, type SessionUser } from '../auth.js';
import { fetchRelated, type Sources } from '../readers/fetch.js';

// S17 (D-37, DV-23): data collection for a deviation from the Logbook and Batchwright (read-only).
export function dataRoutes(app: FastifyInstance, sql: Sql, sources: Sources) {
  const actor = { preHandler: requireRole('user', 'qa') };

  app.get('/api/data/status', actor, async () => ({ logbook: !!sources.logbook, batchwright: !!sources.batchwright }));

  // Anyone working on the deviation (User, QA) may fetch while it is open; each fetch is kept.
  app.post<{ Params: { id: string } }>('/api/deviations/:id/fetch', actor, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const [d] = await sql<{ step: string }[]>`select step from deviations where id = ${id}`;
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (d.step === 'closed' || d.step === 'rejected') return reply.code(409).send({ error: 'closed' });
    // One fetch per deviation every 30 s at most: each one is kept.
    const [recent] = await sql`select 1 from data_fetches where deviation_id = ${id} and fetched_at > now() - interval '30 seconds'`;
    if (recent) return reply.code(429).send({ error: 'too_soon', message: 'The data was fetched less than 30 seconds ago.' });
    const ids = await fetchRelated(sql, sources, id, (req.user as SessionUser).id, (m) => req.log.warn(m));
    return { ids };
  });

  app.get<{ Params: { id: string } }>('/api/deviations/:id/fetches', actor, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    return sql`
      -- Full data only for the newest fetch per source; earlier ones are listed.
      select f.id::int, f.source, f.status, f.params, f.views,
        case when f.id = (select max(x.id) from data_fetches x where x.deviation_id = f.deviation_id and x.source = f.source) then f.data else '{}'::jsonb end as data,
        f.row_count as "rowCount", f.sha256, f.error,
        f.fetched_at as "fetchedAt", u.full_name as "fetchedBy"
      from data_fetches f join users u on u.id = f.fetched_by
      where f.deviation_id = ${id} order by f.id desc limit 40`;
  });
}
