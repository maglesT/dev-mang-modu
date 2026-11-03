import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { can, parseId, requirePermission, type SessionUser } from '../auth.js';
import { authenticateSigner, contentHash, sign, signBody, SignError } from '../signatures.js';
import { PLANT_TZ } from '../deviations.js';
import { assignable, type People } from '../people.js';

export type CapaStep = 'open' | 'done' | 'check' | 'closed';

const text = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a valid date.');
const credentials = signBody.omit({ contentHash: true });

// DV-08: what a CAPA is. Source deviation is linked; the other sources carry a free-text reference (D-13).
const capaFields = z.object({
  type: z.enum(['corrective', 'preventive']),
  description: text(5000),
  // S14 (D-36): CAPA strength (owner method): strong = mistake-proofing / interlock, medium = automation /
  // alarm / checklist, weak = training / SOP revision / awareness.
  strength: z.enum(['strong', 'medium', 'weak'], { errorMap: () => ({ message: 'Choose the CAPA strength (strong, medium or weak).' }) }),
  ownerId: z.number().int().positive(),
  dueDate: isoDate,
  product: z.string().trim().max(200).default(''),
  batch: z.string().trim().max(80).default(''),
});
const raiseBody = capaFields.extend({
  source: z.enum(['deviation', 'audit', 'complaint', 'other']),
  deviationId: z.number().int().positive().optional(),
  sourceRef: z.string().trim().max(500).default(''),
}).superRefine((d, ctx) => {
  if (d.source === 'deviation' && !d.deviationId) ctx.addIssue({ code: 'custom', path: ['deviationId'], message: 'A deviation CAPA is raised from its deviation.' });
  if (d.source !== 'deviation' && !d.sourceRef) ctx.addIssue({ code: 'custom', path: ['sourceRef'], message: 'Give the audit, complaint or other reference.' });
});
// DV-09: at verification QA chooses a dedicated check by a date, or monitoring through the trend and review, with a reason.
const effectiveness = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('check'), checkDue: isoDate, how: text(2000) }),
  z.object({ mode: z.literal('trend'), reason: text(2000) }),
]);
// versionId: the CAPA version the signer was shown; signing is refused if the CAPA changed since (DV-16).
const versionId = z.number().int().positive();
const verifyBody = z.object({ effectiveness, versionId, signature: credentials });
const checkBody = z.object({ effective: z.boolean(), note: text(2000), versionId, signature: credentials });
const doneBody = z.object({ note: text(5000) });
const correctBody = capaFields.extend({ reason: text(2000) });
const dueBody = z.object({ dueDate: isoDate, reason: text(500) });

interface Capa { id: number; number: string; source: string; deviation_id: number | null; step: CapaStep; owner_id: number; raised_by: number }
const lockCapa = async (tx: Tx, id: number) =>
  (await tx<Capa[]>`select id::int, number, source, deviation_id::int, step, owner_id::int, raised_by::int from capas where id = ${id} for update`)[0];
const latestData = async (q: Sql | Tx, id: number) =>
  (await q<{ id: number; version: number; data: Record<string, unknown> }[]>`
    select id::int, version, data from latest_capa_versions where capa_id = ${id}`)[0]!;

async function addVersion(tx: Tx, capaId: number, action: string, data: unknown, userId: number, reason: string | null = null) {
  const [prev] = await tx<{ version: number }[]>`select version from latest_capa_versions where capa_id = ${capaId}`;
  const [row] = await tx<{ id: number }[]>`
    insert into capa_versions (capa_id, version, action, data, saved_by, reason)
    values (${capaId}, ${(prev?.version ?? 0) + 1}, ${action}, ${tx.json(data as never)}, ${userId}, ${reason}) returning id::int`;
  return row!.id;
}

const okOwner = (tx: Tx, people: People, ownerId: number) => assignable(tx, people, ownerId);
const pastDate = async (tx: Tx, d: string) =>
  (await tx<{ past: boolean }[]>`select ${d}::date < (now() at time zone ${PLANT_TZ})::date as past`)[0]!.past;

// SQL: a CAPA is overdue when its due date (or, in the check step, its check date) is past in plant time.
export const capaOverdueSql = (sql: Sql) =>
  sql`(c.step <> 'closed' and (case when c.step = 'check' then c.check_due else c.due_date end) < (now() at time zone ${PLANT_TZ})::date)`;

const problems = (e: z.ZodError) => e.issues.map((i) => i.message);
const signFail = (reply: FastifyReply, e: unknown) => {
  if (e instanceof SignError) return reply.code(e.code === 'wrong_credentials' ? 401 : 409).send({ error: e.code });
  throw e;
};

export function capaRoutes(app: FastifyInstance, sql: Sql) {
  const raiser = { preHandler: requirePermission('deviations.capa.raise') };
  const verifier = { preHandler: requirePermission('deviations.capa.verify') };
  const reader = { preHandler: requirePermission() };

  // DV-08: QA raises a CAPA from a deviation or directly for an audit, complaint or other source.
  app.post('/api/capas', raiser, async (req, reply) => {
    const body = raiseBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', problems: problems(body.error) });
    const { source, deviationId, sourceRef, ...fields } = body.data;
    const out = await sql.begin(async (tx) => {
      if (source === 'deviation') {
        const [d] = await tx<{ step: string }[]>`select step from deviations where id = ${deviationId!} for update`;
        if (!d) return { status: 400, problems: ['Unknown deviation.'] };
        if (d.step === 'rejected' || d.step === 'classification' || d.step === 'approval') return { status: 409, problems: ['CAPAs are raised once the deviation is classified (and approved, if planned).'] };
      }
      if (!(await okOwner(tx, app.people, fields.ownerId))) return { status: 400, problems: ['Choose an active owner from the list.'] };
      if (await pastDate(tx, fields.dueDate)) return { status: 400, problems: ['The due date cannot be in the past.'] };
      await tx`select pg_advisory_xact_lock(hashtext('capa_number'))`;
      const [y] = await tx<{ year: number }[]>`select extract(year from now() at time zone ${PLANT_TZ})::int as year`;
      const [s] = await tx<{ seq: number }[]>`select coalesce(max(seq), 0)::int + 1 as seq from capas where year = ${y!.year}`;
      const number = `CAPA-${y!.year}-${String(s!.seq).padStart(4, '0')}`;
      const [c] = await tx<{ id: number }[]>`
        insert into capas (year, seq, number, source, deviation_id, source_ref, owner_id, due_date, raised_by)
        values (${y!.year}, ${s!.seq}, ${number}, ${source}, ${deviationId ?? null}, ${sourceRef}, ${fields.ownerId}, ${fields.dueDate}::date, ${req.user!.id})
        returning id::int`;
      await addVersion(tx, c!.id, 'raised', fields, req.user!.id);
      await audit(tx, { actorId: req.user!.id, action: 'capa.raised', objectType: 'capa', objectId: c!.id, new: { number, source, deviationId, sourceRef, ...fields } });
      if (deviationId) await audit(tx, { actorId: req.user!.id, action: 'deviation.capa_raised', objectType: 'deviation', objectId: deviationId, new: { capa: number } });
      return { status: 201, id: c!.id, number };
    });
    if (out.status !== 201) return reply.code(out.status).send({ error: 'invalid_request', problems: out.problems });
    return reply.code(201).send({ id: out.id, number: out.number });
  });

  // The CAPA register: filter by source, status, overdue, owner, deviation.
  app.get<{ Querystring: Record<string, string> }>('/api/capas', reader, async (req) => {
    const f = req.query;
    const deviationId = f.deviationId ? parseId(f.deviationId) : null;
    const oversee = can(req.user!, 'deviations.qa.oversee');
    const mine = sql`((c.step = 'open' and c.owner_id = ${req.user!.id}) or (${oversee} and c.step in ('done', 'check')))`;
    return sql`
      select c.id::int, c.number, c.source, c.deviation_id::int as "deviationId", d.number as "deviationNumber", c.source_ref as "sourceRef",
        c.step, to_char(c.due_date, 'YYYY-MM-DD') as "dueDate", to_char(c.check_due, 'YYYY-MM-DD') as "checkDue",
        ${capaOverdueSql(sql)} as overdue, o.full_name as owner, v.data->>'type' as type, v.data->>'description' as description,
        v.data->>'strength' as strength, ${mine} as "waitingForMe"
      from capas c join users o on o.id = c.owner_id join latest_capa_versions v on v.capa_id = c.id
      left join deviations d on d.id = c.deviation_id
      where ${f.source ? sql`c.source = ${f.source}` : sql`true`}
        and ${f.status === 'open' ? sql`c.step <> 'closed'` : f.status === 'closed' ? sql`c.step = 'closed'` : sql`true`}
        and ${f.overdue === '1' ? capaOverdueSql(sql) : sql`true`}
        and ${f.mine === '1' ? mine : sql`true`}
        and ${deviationId ? sql`c.deviation_id = ${deviationId}` : sql`true`}
      order by ${capaOverdueSql(sql)} desc, (c.step = 'closed'), c.due_date, c.id desc
      limit 1000`;
  });

  app.get<{ Params: { id: string } }>('/api/capas/:id', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const [c] = await sql`
      select c.id::int, c.number, c.source, c.deviation_id::int as "deviationId", d.number as "deviationNumber", c.source_ref as "sourceRef",
        c.step, to_char(c.due_date, 'YYYY-MM-DD') as "dueDate", to_char(c.check_due, 'YYYY-MM-DD') as "checkDue",
        ${capaOverdueSql(sql)} as overdue, c.owner_id::int as "ownerId", o.full_name as owner, r.full_name as "raisedBy", c.raised_at as "raisedAt"
      from capas c join users o on o.id = c.owner_id join users r on r.id = c.raised_by left join deviations d on d.id = c.deviation_id
      where c.id = ${id}`;
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const versions = await sql`
      select v.id::int, v.version, v.action, v.data, v.saved_at as "savedAt", u.full_name as "savedBy", v.reason
      from capa_versions v join users u on u.id = v.saved_by where v.capa_id = ${id} order by v.version`;
    const signatures = await sql`
      select g.id::int, g.object_id::int as "versionId", g.printed_name as "printedName", g.meaning, g.signed_at as "signedAt"
      from signatures g where g.object_type = 'capa' and g.object_id in (select id from capa_versions where capa_id = ${id}) order by g.signed_at`;
    const history = await sql`
      select a.id::int, a.at, u.full_name as actor, a.action, a.old_value as "oldValue", a.new_value as "newValue", a.reason
      from audit_log a left join users u on u.id = a.actor_id
      where (a.object_type = 'capa' and a.object_id = ${String(id)})
         or (a.object_type = 'capa_version' and a.object_id in (select id::text from capa_versions where capa_id = ${id}))
      order by a.at, a.id`;
    return { ...c, versions, signatures, history };
  });

  // The owner (or a holder of deviations.qa.oversee) records what was done.
  app.post<{ Params: { id: string } }>('/api/capas/:id/done', { preHandler: requirePermission('deviations.capa.complete') }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = doneBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request', problems: ['Describe what was done.'] });
    const out = await sql.begin(async (tx) => {
      const c = await lockCapa(tx, id);
      if (!c) return 404;
      if (c.step !== 'open') return 409;
      if (c.owner_id !== req.user!.id && !can(req.user!, 'deviations.qa.oversee')) return 403;
      const prev = await latestData(tx, id);
      await addVersion(tx, id, 'done', { ...prev.data, doneNote: body.data.note }, req.user!.id);
      await tx`update capas set step = 'done' where id = ${id}`;
      await audit(tx, { actorId: req.user!.id, action: 'capa.done', objectType: 'capa', objectId: id, new: { note: body.data.note } });
      return 200;
    });
    if (out !== 200) return reply.code(out).send({ error: out === 404 ? 'not_found' : out === 403 ? 'forbidden' : 'wrong_step' });
    return { step: 'done' };
  });

  // DV-08, DV-09: QA verifies with an e-signature and decides how effectiveness is monitored.
  // "Monitored through the trend and review" closes the CAPA at once; a dedicated check waits for its result.
  app.post<{ Params: { id: string } }>('/api/capas/:id/verify', verifier, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = verifyBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request', problems: body.success ? [] : problems(body.error) });
    const user = req.user as SessionUser;
    try {
      const signer = await authenticateSigner(sql, app.proofKey, user, body.data.signature, { objectType: 'capa', objectId: id, meaning: 'verified', needs: 'deviations.capa.verify' });
      return await sql.begin(async (tx) => {
        const c = await lockCapa(tx, id);
        if (!c) return reply.code(404).send({ error: 'not_found' });
        if (c.step !== 'done') return reply.code(409).send({ error: 'wrong_step' });
        const e = body.data.effectiveness;
        if (e.mode === 'check' && (await pastDate(tx, e.checkDue))) return reply.code(400).send({ error: 'invalid_request', problems: ['The check date cannot be in the past.'] });
        const prev = await latestData(tx, id);
        if (prev.id !== body.data.versionId) return reply.code(409).send({ error: 'content_changed' });
        const data = { ...prev.data, effectiveness: e };
        const versionId = await addVersion(tx, id, 'verified', data, user.id);
        await sign(tx, { signer, shownHash: contentHash('capa', versionId, data), objectType: 'capa', objectId: versionId, meaning: 'verified', content: data });
        const step: CapaStep = e.mode === 'trend' ? 'closed' : 'check';
        await tx`update capas set step = ${step}, check_due = ${e.mode === 'check' ? e.checkDue : null}::date where id = ${id}`;
        await audit(tx, { actorId: user.id, action: 'capa.verified', objectType: 'capa', objectId: id, new: { effectiveness: e, step } });
        return { step };
      });
    } catch (err) {
      return signFail(reply, err);
    }
  });

  // DV-09: QA records the effectiveness check and closes the CAPA with an e-signature.
  // "Not effective" closes this CAPA too; QA raises a follow-up CAPA (the screen offers it).
  app.post<{ Params: { id: string } }>('/api/capas/:id/check', verifier, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = checkBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request', problems: body.success ? [] : problems(body.error) });
    const user = req.user as SessionUser;
    try {
      const signer = await authenticateSigner(sql, app.proofKey, user, body.data.signature, { objectType: 'capa', objectId: id, meaning: 'closed', needs: 'deviations.capa.verify' });
      return await sql.begin(async (tx) => {
        const c = await lockCapa(tx, id);
        if (!c) return reply.code(404).send({ error: 'not_found' });
        if (c.step !== 'check') return reply.code(409).send({ error: 'wrong_step' });
        const prev = await latestData(tx, id);
        if (prev.id !== body.data.versionId) return reply.code(409).send({ error: 'content_changed' });
        const data = { ...prev.data, checkResult: { effective: body.data.effective, note: body.data.note } };
        const versionId = await addVersion(tx, id, 'checked', data, user.id);
        await sign(tx, { signer, shownHash: contentHash('capa', versionId, data), objectType: 'capa', objectId: versionId, meaning: 'closed', content: data });
        await tx`update capas set step = 'closed' where id = ${id}`;
        await audit(tx, { actorId: user.id, action: 'capa.checked', objectType: 'capa', objectId: id, new: data.checkResult });
        return { step: 'closed' };
      });
    } catch (err) {
      return signFail(reply, err);
    }
  });

  // DV-14: QA corrects an open CAPA (what, who, when) with a reason; the earlier version stays readable.
  app.post<{ Params: { id: string } }>('/api/capas/:id/correct', raiser, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = correctBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request', problems: body.success ? [] : problems(body.error) });
    const { reason, ...fields } = body.data;
    const out = await sql.begin(async (tx) => {
      const c = await lockCapa(tx, id);
      if (!c) return 404;
      if (c.step !== 'open' && c.step !== 'done') return 409;
      if (!(await okOwner(tx, app.people, fields.ownerId))) return 400;
      if (await pastDate(tx, fields.dueDate)) return 400;
      const prev = await latestData(tx, id);
      await addVersion(tx, id, 'corrected', { ...prev.data, ...fields }, req.user!.id, reason);
      await tx`update capas set owner_id = ${fields.ownerId}, due_date = ${fields.dueDate}::date where id = ${id}`;
      await audit(tx, { actorId: req.user!.id, action: 'capa.corrected', objectType: 'capa', objectId: id, old: prev.data, new: fields, reason });
      return 200;
    });
    if (out === 400) return reply.code(400).send({ error: 'invalid_request', problems: ['Choose an active owner and a due date that is not in the past.'] });
    if (out !== 200) return reply.code(out).send({ error: out === 404 ? 'not_found' : 'wrong_step' });
    return { ok: true };
  });

  // QA moves a due date (or, in the check step, the check date) with a reason (D-15).
  app.post<{ Params: { id: string } }>('/api/capas/:id/due-date', raiser, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = dueBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request', problems: body.success ? [] : problems(body.error) });
    const out = await sql.begin(async (tx) => {
      const c = await lockCapa(tx, id);
      if (!c) return 404;
      if (c.step === 'closed') return 409;
      if (await pastDate(tx, body.data.dueDate)) return 400;
      const prev = await latestData(tx, id);
      const field = c.step === 'check' ? 'checkDue' : 'dueDate';
      const data = c.step === 'check'
        ? { ...prev.data, effectiveness: { ...(prev.data.effectiveness as object), checkDue: body.data.dueDate } }
        : { ...prev.data, dueDate: body.data.dueDate };
      await addVersion(tx, id, 'due_changed', data, req.user!.id, body.data.reason);
      if (c.step === 'check') await tx`update capas set check_due = ${body.data.dueDate}::date where id = ${id}`;
      else await tx`update capas set due_date = ${body.data.dueDate}::date where id = ${id}`;
      await audit(tx, { actorId: req.user!.id, action: 'capa.due_changed', objectType: 'capa', objectId: id, new: { [field]: body.data.dueDate }, reason: body.data.reason });
      return 200;
    });
    if (out === 400) return reply.code(400).send({ error: 'invalid_request', problems: ['The date cannot be in the past.'] });
    if (out !== 200) return reply.code(out).send({ error: out === 404 ? 'not_found' : 'wrong_step' });
    return { ok: true };
  });
}
