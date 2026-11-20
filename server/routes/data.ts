import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db.js';
import { INVESTIGATES, parseId, requirePermission, type SessionUser } from '../auth.js';
import { fetchRelated, type Sources } from '../readers/fetch.js';
import { batchPicks } from '../readers/picks.js';
import { LIMS_OFF, listOos } from '../readers/lims.js';
import { BATCH_PRODUCTS } from '../readers/truebatch.js';
import { ended } from '../deviations.js';

// S17 (D-37, DV-23): data collection for a deviation from the TrueBatch products (D-51, D-57) and the Logbook (read-only; Batchwright retired, D-56).
export function dataRoutes(app: FastifyInstance, sql: Sql, sources: Sources) {
  const actor = { preHandler: requirePermission(...INVESTIGATES) };

  app.get('/api/data/status', actor, async () => ({ logbook: !!sources.logbook, ...Object.fromEntries(BATCH_PRODUCTS.map((p) => [p, !!sources[p]])) }));

  // D-57: the batches of the linked TrueBatch products for the report form's pick list (newest first per product).
  // Products not linked are not listed; one off or down is left out with a note.
  app.get('/api/batches', { preHandler: requirePermission('deviations.deviation.report', 'deviations.qa.oversee') }, async (req) => ({
    ...(await batchPicks(sources, (m) => req.log.warn(m))),
    linked: BATCH_PRODUCTS.filter((p) => sources[p]),
  }));

  // D-60: the open OOS of LIMS for the report form's OOS pick (newest first): each says whether phase II can be filed and
  // which deviation already has it. Not linked: an empty list, saying so; off or down: an empty list with the reason.
  app.get('/api/oos', { preHandler: requirePermission('deviations.deviation.report', 'deviations.qa.oversee') }, async (req) => {
    if (!sources.lims) return { linked: false, oos: [], note: null };
    try {
      return { linked: true, oos: await listOos(sql, sources.lims), note: null };
    } catch (e) {
      req.log.warn(`LIMS OOS list failed: ${e instanceof Error ? e.message : String(e)}`);
      const off = ['42501', '28000'].includes((e as { code?: string }).code ?? '');
      return { linked: true, oos: [], note: off ? LIMS_OFF : 'LIMS could not be read now, so its OOS are not listed. Try again later.' };
    }
  });

  // Anyone working on the deviation (investigation.write or qa.oversee) may fetch while it is open; each fetch is kept.
  app.post<{ Params: { id: string } }>('/api/deviations/:id/fetch', actor, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const [d] = await sql<{ step: string }[]>`select step from deviations where id = ${id}`;
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (ended(d.step)) return reply.code(409).send({ error: 'closed' });
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
