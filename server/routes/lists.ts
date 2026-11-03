import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';

const nameBody = z.object({ name: z.string().trim().min(1).max(120) });
const updateBody = z.object({ name: z.string().trim().min(1).max(120).optional(), active: z.boolean().optional(), reason: z.string().trim().min(1).max(500) });
const settingsBody = z.object({
  siteName: z.string().trim().min(1).max(120),
  targetDaysMinor: z.number().int().min(1).max(365),
  targetDaysMajor: z.number().int().min(1).max(365),
  targetDaysCritical: z.number().int().min(1).max(365),
  reason: z.string().trim().min(1).max(500),
});

// Areas and deviation types (D-12) and the settings row (D-10). Holders of deviations.settings.manage change them; every change is
// audited (DV-15) and falls under the site's change procedure (CP-07).
export function listRoutes(app: FastifyInstance, sql: Sql) {
  const anyone = { preHandler: requirePermission() };
  const admin = { preHandler: requirePermission('deviations.settings.manage') };

  // S14 (D-36): Admin marks a deviation type as lab / OOS; its investigations then need the KT checklist.
  app.patch<{ Params: { id: string } }>('/api/deviation-types/:id/lab', admin, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = z.object({ labOos: z.boolean(), reason: z.string().trim().min(1).max(500) }).safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request', problems: ['Give the reason for the change.'] });
    return sql.begin(async (tx) => {
      const [before] = await tx<{ lab_oos: boolean }[]>`select lab_oos from deviation_types where id = ${id} for update`;
      if (!before) return reply.code(404).send({ error: 'not_found' });
      await tx`update deviation_types set lab_oos = ${body.data.labOos} where id = ${id}`;
      await audit(tx, { actorId: req.user!.id, action: 'deviation_type.lab_changed', objectType: 'deviation_type', objectId: id, old: { labOos: before.lab_oos }, new: { labOos: body.data.labOos }, reason: body.data.reason });
      return { id, labOos: body.data.labOos };
    });
  });

  for (const [path, table, objectType] of [['areas', 'areas', 'area'], ['deviation-types', 'deviation_types', 'deviation_type']] as const) {
    app.get(`/api/${path}`, anyone, async () =>
      sql`select id::int, name, active ${table === 'deviation_types' ? sql`, lab_oos as "labOos"` : sql``} from ${sql(table)} order by name`);

    app.post(`/api/${path}`, admin, async (req, reply) => {
      const body = nameBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const row = await sql.begin(async (tx) => {
        // Serialise adds so two at once cannot both pass the case-insensitive check.
        await tx`select pg_advisory_xact_lock(hashtext(${table}))`;
        const [exists] = await tx`select 1 from ${tx(table)} where lower(name) = lower(${body.data.name})`;
        if (exists) return null;
        const [r] = await tx<{ id: number }[]>`insert into ${tx(table)} (name) values (${body.data.name}) returning id::int`;
        await audit(tx, { actorId: req.user!.id, action: `${objectType}.created`, objectType, objectId: r!.id, new: { name: body.data.name } });
        return r!;
      });
      if (!row) return reply.code(409).send({ error: 'name_taken' });
      return reply.code(201).send({ id: row.id, name: body.data.name, active: true });
    });

    app.patch<{ Params: { id: string } }>(`/api/${path}/:id`, admin, async (req, reply) => {
      const body = updateBody.safeParse(req.body);
      const id = parseId(req.params.id);
      if (!body.success || id === null) return reply.code(400).send({ error: 'invalid_request' });
      const out = await sql.begin(async (tx) => {
        const [before] = await tx<{ name: string; active: boolean }[]>`select name, active from ${tx(table)} where id = ${id} for update`;
        if (!before) return null;
        if (body.data.name) {
          const [dup] = await tx`select 1 from ${tx(table)} where lower(name) = lower(${body.data.name}) and id <> ${id}`;
          if (dup) return 'taken' as const;
        }
        const after = { name: body.data.name ?? before.name, active: body.data.active ?? before.active };
        await tx`update ${tx(table)} set name = ${after.name}, active = ${after.active} where id = ${id}`;
        await audit(tx, { actorId: req.user!.id, action: `${objectType}.updated`, objectType, objectId: id, old: before, new: after, reason: body.data.reason });
        return { id, ...after };
      });
      if (!out) return reply.code(404).send({ error: 'not_found' });
      if (out === 'taken') return reply.code(409).send({ error: 'name_taken' });
      return out;
    });
  }

  app.get('/api/settings', anyone, async () => {
    const [s] = await sql`select site_name as "siteName", target_days_minor as "targetDaysMinor",
      target_days_major as "targetDaysMajor", target_days_critical as "targetDaysCritical" from settings`;
    return s;
  });

  app.put('/api/settings', admin, async (req, reply) => {
    const body = settingsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const { reason, ...s } = body.data;
    await sql.begin(async (tx) => {
      const [before] = await tx`select site_name as "siteName", target_days_minor as "targetDaysMinor",
        target_days_major as "targetDaysMajor", target_days_critical as "targetDaysCritical" from settings for update`;
      await tx`update settings set site_name = ${s.siteName}, target_days_minor = ${s.targetDaysMinor},
        target_days_major = ${s.targetDaysMajor}, target_days_critical = ${s.targetDaysCritical}`;
      await audit(tx, { actorId: req.user!.id, action: 'settings.updated', objectType: 'settings', objectId: 1, old: before, new: s, reason });
    });
    return s;
  });
}
