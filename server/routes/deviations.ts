import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requireRole, type SessionUser } from '../auth.js';
import { authenticateSigner, contentHash, sign, signBody, SignError, type Meaning } from '../signatures.js';
import {
  PLANT_TZ, addSection, classificationData, normaliseBatch, overdueSql, reportData, targetDate, writeBatches,
  type ClassificationData, type ReportData, type Step,
} from '../deviations.js';

const problems = (e: z.ZodError) => e.issues.map((i) => i.message);
const reasonSign = signBody.extend({ reason: z.string().trim().min(1).max(2000) });
const targetBody = z.object({ targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().trim().min(1).max(500) });

interface Header {
  id: number;
  number: string;
  planned: boolean;
  reporter_id: number;
  step: Step;
  classification: string | null;
  investigator_id: number | null;
}

const lockHeader = async (tx: Tx, id: number) =>
  (await tx<Header[]>`select id::int, number, planned, reporter_id::int, step, classification, investigator_id::int
    from deviations where id = ${id} for update`)[0];

const latest = async (q: Sql | Tx, id: number, kind: string) =>
  (await q<{ id: number; version: number; data: Record<string, unknown> }[]>`
    select id::int, version, data from latest_sections where deviation_id = ${id} and kind = ${kind}`)[0];

// What QA signs when approving or rejecting a planned deviation: the report and the classification as shown.
async function approvalContent(q: Sql | Tx, id: number) {
  const report = await latest(q, id, 'report');
  const classification = await latest(q, id, 'classification');
  if (!classification) return null;
  return { sectionId: classification.id, content: { report: report?.data, classification: classification.data } };
}

const signFail = (reply: FastifyReply, e: unknown) => {
  if (e instanceof SignError) {
    const status = e.code === 'wrong_credentials' ? 401 : e.code === 'not_allowed' ? 403 : 409;
    return reply.code(status).send({ error: e.code });
  }
  throw e;
};

export function deviationRoutes(app: FastifyInstance, sql: Sql) {
  const reporter = { preHandler: requireRole('user', 'qa') };
  const qa = { preHandler: requireRole('qa') };
  const reader = { preHandler: requireRole() };

  // DV-01: anyone (except an Admin-only account) reports a deviation and gets its number at once.
  app.post('/api/deviations', reporter, async (req, reply) => {
    const body = reportData.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', problems: problems(body.error) });
    const d = body.data;
    const result = await sql.begin(async (tx) => {
      const [area] = await tx`select 1 from areas where id = ${d.areaId} and active`;
      if (!area) return null;
      // Numbers are sequential per year and never reused (the lock serialises numbering).
      await tx`select pg_advisory_xact_lock(hashtext('deviation_number'))`;
      const [y] = await tx<{ year: number }[]>`select extract(year from now() at time zone ${PLANT_TZ})::int as year`;
      const year = y!.year;
      const [s] = await tx<{ seq: number }[]>`select coalesce(max(seq), 0)::int + 1 as seq from deviations where year = ${year}`;
      const seq = s!.seq;
      const number = `DEV-${year}-${String(seq).padStart(4, '0')}`;
      const [dev] = await tx<{ id: number }[]>`
        insert into deviations (year, seq, number, planned, reporter_id) values (${year}, ${seq}, ${number}, ${d.planned}, ${req.user!.id})
        returning id::int`;
      const section = await addSection(tx, dev!.id, 'report', d, req.user!.id);
      await writeBatches(tx, dev!.id, section.id, d.products.map((p) => ({ ...p, role: 'own' as const })));
      await audit(tx, { actorId: req.user!.id, action: 'deviation.reported', objectType: 'deviation', objectId: dev!.id, new: { number, ...d } });
      return { id: dev!.id, number };
    });
    if (!result) return reply.code(400).send({ error: 'invalid_request', problems: ['Choose an area from the list.'] });
    return reply.code(201).send(result);
  });

  // Lists: open, overdue, all, waiting for me; the search box takes a number, a word or a batch (DV-11).
  app.get<{ Querystring: { view?: string; q?: string } }>('/api/deviations', reader, async (req) => {
    const user = req.user!;
    const view = req.query.view ?? 'open';
    const q = (req.query.q ?? '').trim().slice(0, 100);
    const isQa = user.roles.includes('qa');
    const mine = sql`(
      (d.step = 'investigation' and d.investigator_id = ${user.id})
      or (${isQa} and d.step in ('classification', 'approval', 'closure') and not (d.step = 'classification' and d.reporter_id = ${user.id}))
    )`;
    const filter =
      view === 'all' ? sql`true`
      : view === 'overdue' ? overdueSql(sql)
      : view === 'mine' ? mine
      : sql`d.step not in ('closed', 'rejected')`;
    const search = q
      ? sql`(d.number ilike ${'%' + q + '%'} or r.data->>'title' ilike ${'%' + q + '%'}
            or exists (select 1 from batches b join latest_sections s on s.id = b.section_id
                       where b.deviation_id = d.id and b.batch_norm = ${normaliseBatch(q)}))`
      : sql`true`;
    return sql`
      select d.id::int, d.number, d.planned, d.step, d.classification,
        to_char(d.target_date, 'YYYY-MM-DD') as "targetDate", ${overdueSql(sql)} as overdue,
        d.reported_at as "reportedAt", r.data->>'title' as title, a.name as area,
        rep.full_name as reporter, inv.full_name as investigator,
        coalesce((select string_agg(b.product || ' / ' || b.batch, '; ' order by b.id) from batches b
                  where b.section_id = r.id and b.role = 'own'), '') as batches,
        ${mine} as "waitingForMe"
      from deviations d
      join latest_sections r on r.deviation_id = d.id and r.kind = 'report'
      left join areas a on a.id = (r.data->>'areaId')::bigint
      join users rep on rep.id = d.reporter_id
      left join users inv on inv.id = d.investigator_id
      where ${filter} and ${search}
      order by ${overdueSql(sql)} desc, d.target_date nulls first, d.id desc
      limit 500`;
  });

  // One deviation: header, every version of every section, signatures, history (DV-14, DV-15, DV-16).
  app.get<{ Params: { id: string } }>('/api/deviations/:id', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const [d] = await sql`
      select d.id::int, d.number, d.planned, d.step, d.classification, to_char(d.target_date, 'YYYY-MM-DD') as "targetDate",
        ${overdueSql(sql)} as overdue, d.reported_at as "reportedAt", d.reporter_id::int as "reporterId",
        rep.full_name as reporter, d.investigator_id::int as "investigatorId", inv.full_name as investigator, a.name as area
      from deviations d join users rep on rep.id = d.reporter_id left join users inv on inv.id = d.investigator_id
      join latest_sections r on r.deviation_id = d.id and r.kind = 'report'
      left join areas a on a.id = (r.data->>'areaId')::bigint
      where d.id = ${id}`;
    if (!d) return reply.code(404).send({ error: 'not_found' });
    const sections = await sql`
      select s.id::int, s.kind, s.version, s.data, s.saved_at as "savedAt", u.full_name as "savedBy", s.reason,
        (s.id = l.id) as latest
      from sections s join users u on u.id = s.saved_by
      join latest_sections l on l.deviation_id = s.deviation_id and l.kind = s.kind
      where s.deviation_id = ${id} order by s.kind, s.version`;
    const signatures = await sql`
      select g.id::int, g.object_id::int as "sectionId", g.printed_name as "printedName", g.meaning, g.signed_at as "signedAt"
      from signatures g where g.object_type = 'section' and g.object_id in (select id from sections where deviation_id = ${id})
      order by g.signed_at`;
    const batches = await sql`
      select b.role, b.product, b.batch, b.outcome from batches b join latest_sections s on s.id = b.section_id
      where b.deviation_id = ${id} order by b.id`;
    const history = await sql`
      select a.id::int, a.at, u.full_name as actor, a.action, a.old_value as "oldValue", a.new_value as "newValue", a.reason
      from audit_log a left join users u on u.id = a.actor_id
      where (a.object_type = 'deviation' and a.object_id = ${String(id)})
         or (a.object_type = 'section' and a.object_id in (select id::text from sections where deviation_id = ${id}))
      order by a.at, a.id`;
    const approval = d.step === 'approval' ? await approvalContent(sql, id) : null;
    return {
      ...d,
      sections,
      signatures,
      batches,
      history,
      approvalHash: approval ? contentHash('section', approval.sectionId, approval.content) : null,
    };
  });

  // People who can investigate or own a CAPA (active, role User or QA), for the pick lists.
  app.get('/api/people', reader, async () =>
    sql`select u.id::int, u.full_name as "fullName", u.username from users u
        where u.active and exists (select 1 from user_roles r where r.user_id = u.id and r.role in ('user', 'qa'))
        order by u.full_name`);

  // DV-03, DV-20: QA classifies; the reporter cannot classify their own deviation (independent check).
  app.post<{ Params: { id: string } }>('/api/deviations/:id/classify', qa, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = classificationData.safeParse(req.body);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', problems: problems(body.error) });
    const c: ClassificationData = body.data;
    const out = await sql.begin(async (tx) => {
      const d = await lockHeader(tx, id);
      if (!d) return { status: 404, error: 'not_found' };
      if (d.step !== 'classification') return { status: 409, error: 'wrong_step' };
      if (d.reporter_id === req.user!.id) return { status: 403, error: 'reporter_cannot_classify' };
      const [type] = await tx`select 1 from deviation_types where id = ${c.typeId} and active`;
      const [inv] = await tx`select 1 from users u where u.id = ${c.investigatorId} and u.active
        and exists (select 1 from user_roles r where r.user_id = u.id and r.role in ('user', 'qa'))`;
      if (!type || !inv) return { status: 400, error: 'invalid_request', problems: ['Choose a deviation type and an investigator from the lists.'] };
      const section = await addSection(tx, id, 'classification', c, req.user!.id);
      const target = await targetDate(tx, id, c.classification);
      const step: Step = d.planned ? 'approval' : 'investigation';
      await tx`update deviations set classification = ${c.classification}, target_date = ${target},
        investigator_id = ${c.investigatorId}, step = ${step} where id = ${id}`;
      await audit(tx, { actorId: req.user!.id, action: 'deviation.classified', objectType: 'section', objectId: section.id,
        new: { ...c, targetDate: target, step } });
      return { status: 200, step, targetDate: target };
    });
    if (out.status !== 200) return reply.code(out.status).send(out);
    return { step: out.step, targetDate: out.targetDate };
  });

  // DV-02: a planned deviation is approved (or rejected) by QA with an e-signature before it proceeds.
  for (const [path, meaning] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
    app.post<{ Params: { id: string } }>(`/api/deviations/:id/${path}`, qa, async (req, reply) => {
      const id = parseId(req.params.id);
      const body = (meaning === 'rejected' ? reasonSign : signBody).safeParse(req.body);
      if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
      try {
        const signer = await authenticateSigner(sql, req.user as SessionUser, body.data, { objectType: 'deviation', objectId: id, meaning: meaning as Meaning });
        return await sql.begin(async (tx) => {
          const d = await lockHeader(tx, id);
          if (!d) return reply.code(404).send({ error: 'not_found' });
          if (d.step !== 'approval') return reply.code(409).send({ error: 'wrong_step' });
          const a = (await approvalContent(tx, id))!;
          await sign(tx, { signer, shownHash: body.data.contentHash, objectType: 'section', objectId: a.sectionId, meaning, content: a.content });
          const step: Step = meaning === 'approved' ? 'investigation' : 'rejected';
          await tx`update deviations set step = ${step} where id = ${id}`;
          const reason = 'reason' in body.data ? (body.data.reason as string) : null;
          await audit(tx, { actorId: req.user!.id, action: `deviation.${meaning}`, objectType: 'deviation', objectId: id, new: { step }, reason });
          return { step };
        });
      } catch (e) {
        return signFail(reply, e);
      }
    });
  }

  // QA moves a target closure date, with a reason; the old date stays in the history (D-15).
  app.post<{ Params: { id: string } }>('/api/deviations/:id/target-date', qa, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = targetBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const out = await sql.begin(async (tx) => {
      const d = await lockHeader(tx, id);
      if (!d) return 404;
      if (!d.classification || d.step === 'closed' || d.step === 'rejected') return 409;
      const [old] = await tx<{ t: string }[]>`select to_char(target_date, 'YYYY-MM-DD') as t from deviations where id = ${id}`;
      const section = await addSection(tx, id, 'target_date', { targetDate: body.data.targetDate, previous: old!.t }, req.user!.id, body.data.reason);
      await tx`update deviations set target_date = ${body.data.targetDate} where id = ${id}`;
      await audit(tx, { actorId: req.user!.id, action: 'deviation.target_date_changed', objectType: 'section', objectId: section.id,
        old: { targetDate: old!.t }, new: { targetDate: body.data.targetDate }, reason: body.data.reason });
      return 200;
    });
    if (out !== 200) return reply.code(out).send({ error: out === 404 ? 'not_found' : 'wrong_step' });
    return { targetDate: body.data.targetDate };
  });
}

export type { ReportData };
