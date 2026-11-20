import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import type { Sources } from '../readers/fetch.js';
import { confirmPicks } from '../readers/picks.js';
import { withQmsOpen } from '../readers/qms.js';
import { LIMS_AREA_OFF, limsArea, OOS_PREFIX, oosProduct, pickOos, type OosRef } from '../readers/lims.js';
import { assignable } from '../people.js';
import { can, parseId, requirePermission, type SessionUser } from '../auth.js';
import { authenticateSigner, contentHash, sign, signBody, SignError, type Meaning } from '../signatures.js';
import {
  fileDeviation, ended,
  PLANT_TZ, addSection, checkClassification, classificationData, isSigned, normaliseBatch, overdueSql, recomputeStep, reportData, targetDate, writeBatches,
  type ClassificationData, type ReportData, type Step,
  investigationContext,
} from '../deviations.js';

const problems = (e: z.ZodError) => e.issues.map((i) => i.message);
const reasonSign = signBody.extend({ reason: z.string().trim().min(1).max(2000) });
// A real calendar date: "2026-02-30" is refused rather than rolled over.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a valid date.');
// D-67: the reason and the signing proof for "not a deviation".
const cancelBody = z.object({ reason: z.string().trim().min(1).max(2000), signature: signBody.pick({ proof: true }) });
const targetBody = z.object({ targetDate: isoDate, reason: z.string().trim().min(1).max(500) });
// LIKE wildcards in a search are taken literally.
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

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
  if (e instanceof SignError) return reply.code(e.code === 'wrong_credentials' ? 401 : 409).send({ error: e.code });
  throw e;
};

export function deviationRoutes(app: FastifyInstance, sql: Sql, sources: Sources = {}) {
  const reader = { preHandler: requirePermission() };

  // DV-01: anyone holding deviations.deviation.report reports a deviation and gets its number at once.
  const reporter = { preHandler: requirePermission('deviations.deviation.report') };
  app.post('/api/deviations', reporter, async (req, reply) => {
    const body = reportData.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', problems: problems(body.error) });
    let d = body.data;
    // D-60: an OOS picked from LIMS is read there once, on saving: the report keeps it as read, its lot is the report's
    // first batch (pulled, not typed), and the OOS is filed once (source_ref, unique).
    let sourceRef: string | null = null;
    let oosNumber = '';
    if (d.oos) {
      const pick = await pickOos(sql, sources.lims, d.oos.id);
      if ('problem' in pick) return reply.code(400).send({ error: 'invalid_request', problems: [pick.problem] });
      d = { ...d, oos: pick.oos, noBatch: false, products: [oosProduct(pick.oos), ...d.products.filter((p) => p.from !== 'lims')].slice(0, 20) };
      sourceRef = OOS_PREFIX + pick.oos.id;
      oosNumber = pick.oos.number;
    }
    // D-57: a batch picked from a TrueBatch product is checked there once, on saving.
    const picks = await confirmPicks(sources, d.products);
    if (picks.length) return reply.code(400).send({ error: 'invalid_request', problems: picks });
    const report = d;
    let result;
    try {
      result = await sql.begin(async (tx) => {
        if (!report.oos) return fileDeviation(tx, report, req.user!.id, sourceRef);
        // D-61: an OOS is filed in the QC laboratory area (an EM OOS: its room; made the first time), whatever the form sent.
        const areaId = await limsArea(tx, req.user!.id, report.oos as OosRef);
        return areaId ? fileDeviation(tx, { ...report, areaId }, req.user!.id, sourceRef) : 'area_off' as const;
      });
    } catch (e) {
      // D-60: the same OOS filed by someone else a moment before (unique source_ref).
      if (sourceRef && (e as { code?: string }).code === '23505') {
        return reply.code(400).send({ error: 'invalid_request', problems: [`${oosNumber} already has a deviation. Open that deviation instead.`] });
      }
      throw e;
    }
    if (result === 'area_off') return reply.code(400).send({ error: 'invalid_request', problems: [LIMS_AREA_OFF] });
    if (!result) return reply.code(400).send({ error: 'invalid_request', problems: ['Choose an area from the list.'] });
    return reply.code(201).send(result);
  });

  // Lists: open, overdue, all, waiting for me; the search box takes a number, a word or a batch (DV-11).
  app.get<{ Querystring: { view?: string; q?: string } }>('/api/deviations', reader, async (req) => {
    const user = req.user!;
    const view = req.query.view ?? 'open';
    const q = (req.query.q ?? '').trim().slice(0, 100);
    const mine = sql`(
      (d.step = 'investigation' and d.investigator_id = ${user.id})
      or (${can(user, 'deviations.deviation.classify')} and d.step = 'classification' and d.reporter_id <> ${user.id})
      or (${can(user, 'deviations.deviation.approve')} and d.step = 'approval')
      or (${can(user, 'deviations.deviation.close')} and d.step = 'closure')
    )`;
    const filter =
      view === 'all' ? sql`true`
      : view === 'overdue' ? overdueSql(sql)
      : view === 'mine' ? mine
      // D-67: a report QA cancelled as not a deviation is listed only under its own filter (and in all).
      : view === 'cancelled' ? sql`d.step = 'cancelled'`
      : sql`d.step not in ('closed', 'rejected', 'cancelled')`;
    const like = '%' + likeEscape(q) + '%';
    const norm = normaliseBatch(q);
    const search = q
      ? sql`(d.number ilike ${like} or r.data->>'title' ilike ${like}
            or (${norm !== ''} and exists (select 1 from batches b join latest_sections s on s.id = b.section_id
                       where b.deviation_id = d.id and b.batch_norm = ${norm})))`
      : sql`true`;
    // D-63: the open CAPAs counted once: local ones, plus the QMS's when the QMS owns CAPA and answers.
    return withQmsOpen(sources.qms, await sql<{ number: string; openCapas: number }[]>`
      select d.id::int, d.number, d.planned, d.step, d.classification,
        to_char(d.target_date, 'YYYY-MM-DD') as "targetDate", ${overdueSql(sql)} as overdue,
        d.reported_at as "reportedAt", r.data->>'title' as title, a.name as area,
        rep.full_name as reporter, inv.full_name as investigator,
        coalesce((select string_agg(b.product || ' / ' || b.batch, '; ' order by b.id) from batches b
                  where b.section_id = r.id and b.role = 'own'), '') as batches,
        ${mine} as "waitingForMe",
        (select count(*)::int from capas c where c.deviation_id = d.id and c.step <> 'closed') as "openCapas"
      from deviations d
      join latest_sections r on r.deviation_id = d.id and r.kind = 'report'
      left join areas a on a.id = (r.data->>'areaId')::bigint
      join users rep on rep.id = d.reporter_id
      left join users inv on inv.id = d.investigator_id
      where ${filter} and ${search}
      order by ${overdueSql(sql)} desc, d.target_date nulls first, d.id desc
      limit 500`, (m) => req.log.warn(m));
  });

  // One deviation: header, every version of every section, signatures, history (DV-14, DV-15, DV-16).
  app.get<{ Params: { id: string } }>('/api/deviations/:id', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const [d] = await sql`
      select d.id::int, d.number, d.planned, d.step, d.classification, to_char(d.target_date, 'YYYY-MM-DD') as "targetDate",
        ${overdueSql(sql)} as overdue, d.reported_at as "reportedAt", d.reporter_id::int as "reporterId",
        rep.full_name as reporter, d.investigator_id::int as "investigatorId", inv.full_name as investigator, a.name as area,
        (select count(*)::int from capas c where c.deviation_id = d.id and c.step <> 'closed') as "openCapas"
      from deviations d join users rep on rep.id = d.reporter_id left join users inv on inv.id = d.investigator_id
      join latest_sections r on r.deviation_id = d.id and r.kind = 'report'
      left join areas a on a.id = (r.data->>'areaId')::bigint
      where d.id = ${id}`;
    if (!d) return reply.code(404).send({ error: 'not_found' });
    // D-63: open CAPAs counted once, the QMS's included when it owns CAPA.
    const [counted] = await withQmsOpen(sources.qms, [d as unknown as { number: string; openCapas: number }], (m) => req.log.warn(m));
    d.openCapas = counted!.openCapas;
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
      select b.role, b.product, b.batch, b.outcome, b.batch_typed as typed from batches b join latest_sections s on s.id = b.section_id
      where b.deviation_id = ${id} order by b.id`;
    const history = await sql`
      select a.id::int, a.at, u.full_name as actor, a.action, a.old_value as "oldValue", a.new_value as "newValue", a.reason
      from audit_log a left join users u on u.id = a.actor_id
      where (a.object_type = 'deviation' and a.object_id = ${String(id)})
         or (a.object_type = 'section' and a.object_id in (select id::text from sections where deviation_id = ${id}))
      order by a.at, a.id`;
    const approval = d.step === 'approval' ? await approvalContent(sql, id) : null;
    // After a correction the latest investigation version needs signing again (DV-14).
    const inv = d.step === 'investigation' ? await latest(sql, id, 'investigation') : undefined;
    const investigation = inv && !(await isSigned(sql, inv.id, 'investigation_complete')) ? inv : undefined;
    const attachments = await sql`
      select a.id::int, a.filename, a.mime, a.size, a.sha256, a.uploaded_at as "uploadedAt", u.full_name as "uploadedBy", a.uploaded_by::int as "uploaderId",
        w.reason as "withdrawnReason", w.withdrawn_at as "withdrawnAt"
      from attachments a join users u on u.id = a.uploaded_by left join attachment_withdrawals w on w.attachment_id = a.id
      where a.deviation_id = ${id} order by a.id`;
    // S14: which context tools the investigation needs (KT for lab / OOS types, fault tree when critical).
    const tools = await investigationContext(sql, id);
    return {
      ...d,
      labOos: tools.labOos,
      sections,
      signatures,
      batches,
      history,
      attachments,
      approvalHash: approval ? contentHash('section', approval.sectionId, approval.content) : null,
      investigationHash: investigation ? contentHash('section', investigation.id, investigation.data) : null,
    };
  });

  // People who can investigate or own a CAPA, for the pick lists: people who signed on here with a Deviations code
  // (or were moved), and whom core lists as active now (PL-08; a cut link gives "Connection to core is off").
  app.get('/api/people', reader, async () => {
    const rows = await sql<{ id: number; fullName: string; username: string; employee_id: string }[]>`
      select u.id::int, u.full_name as "fullName", u.username, u.employee_id::text from users u
      where u.employee_id is not null order by u.full_name`;
    const active = await app.people.active(rows.map((r) => r.employee_id));
    return rows.filter((r) => active.has(r.employee_id)).map(({ employee_id: _, ...r }) => r);
  });

  // DV-03, DV-20: QA classifies; the reporter cannot classify their own deviation (independent check).
  app.post<{ Params: { id: string } }>('/api/deviations/:id/classify', { preHandler: requirePermission('deviations.deviation.classify') }, async (req, reply) => {
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
      const inv = await assignable(tx, app.people, c.investigatorId);
      if (!type || !inv) return { status: 400, error: 'invalid_request', problems: ['Choose a deviation type and an investigator from the lists.'] };
      const checked = await checkClassification(tx, id, c);
      if ('problem' in checked) return { status: 400, error: 'invalid_request', problems: [checked.problem] };
      const section = await addSection(tx, id, 'classification', checked.data, req.user!.id);
      const target = await targetDate(tx, id, c.classification);
      const step: Step = d.planned ? 'approval' : 'investigation';
      await tx`update deviations set classification = ${c.classification}, target_date = ${target},
        investigator_id = ${c.investigatorId}, step = ${step} where id = ${id}`;
      await audit(tx, { actorId: req.user!.id, action: 'deviation.classified', objectType: 'section', objectId: section.id,
        new: { ...checked.data, targetDate: target, step } });
      return { status: 200, step, targetDate: target };
    });
    if (out.status !== 200) return reply.code(out.status).send(out);
    return { step: out.step, targetDate: out.targetDate };
  });

  // DV-02: a planned deviation is approved (or rejected) by QA with an e-signature before it proceeds.
  for (const [path, meaning] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
    app.post<{ Params: { id: string } }>(`/api/deviations/:id/${path}`, { preHandler: requirePermission('deviations.deviation.approve') }, async (req, reply) => {
      const id = parseId(req.params.id);
      const body = (meaning === 'rejected' ? reasonSign : signBody).safeParse(req.body);
      if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
      try {
        const signer = await authenticateSigner(sql, app.proofKey, req.user as SessionUser, body.data,
          { objectType: 'deviation', objectId: id, meaning: meaning as Meaning, needs: 'deviations.deviation.approve' });
        return await sql.begin(async (tx) => {
          const d = await lockHeader(tx, id);
          if (!d) return reply.code(404).send({ error: 'not_found' });
          if (d.step !== 'approval') return reply.code(409).send({ error: 'wrong_step' });
          // The approval is the independent check of a planned deviation: not by the person who asked for it.
          if (d.reporter_id === req.user!.id) return reply.code(403).send({ error: 'reporter_cannot_approve' });
          const a = (await approvalContent(tx, id))!;
          await sign(tx, { signer, shownHash: body.data.contentHash, objectType: 'section', objectId: a.sectionId, meaning, content: a.content });
          // After a renewed approval the deviation returns to where it was (e.g. its signed investigation stays valid).
          const step: Step = meaning === 'approved' ? await recomputeStep(tx, { ...d, step: 'investigation' }) : 'rejected';
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
  app.post<{ Params: { id: string } }>('/api/deviations/:id/target-date', { preHandler: requirePermission('deviations.deviation.classify') }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = targetBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const out = await sql.begin(async (tx) => {
      const d = await lockHeader(tx, id);
      if (!d) return 404;
      // Not while a planned deviation awaits approval: the approver signs what is on the screen.
      if (!d.classification || ended(d.step) || d.step === 'approval') return 409;
      const [old] = await tx<{ t: string; before_report: boolean }[]>`
        select to_char(target_date, 'YYYY-MM-DD') as t, ${body.data.targetDate}::date < (reported_at at time zone ${PLANT_TZ})::date as before_report
        from deviations where id = ${id}`;
      if (old!.before_report) return 400;
      const section = await addSection(tx, id, 'target_date', { targetDate: body.data.targetDate, previous: old!.t }, req.user!.id, body.data.reason);
      await tx`update deviations set target_date = ${body.data.targetDate}::date where id = ${id}`;
      await audit(tx, { actorId: req.user!.id, action: 'deviation.target_date_changed', objectType: 'section', objectId: section.id,
        old: { targetDate: old!.t }, new: { targetDate: body.data.targetDate }, reason: body.data.reason });
      return 200;
    });
    if (out === 400) return reply.code(400).send({ error: 'invalid_request', problems: ['The target date cannot be before the report date.'] });
    if (out !== 200) return reply.code(out).send({ error: out === 404 ? 'not_found' : 'wrong_step' });
    return { targetDate: body.data.targetDate };
  });

  // D-67: QA cancels a report as "not a deviation" before the investigation is signed (awaiting classification,
  // awaiting approval, or classified and under investigation), with a reason and one e-signature. Not the reporter
  // (independent check), not once a CAPA was raised here or the deviation was ever closed. The record is kept: the reason
  // is a new section 'cancellation', signed 'cancelled'; the step becomes 'cancelled' (not open, never overdue, not in the
  // trends). source_ref stays, so an automatic report is never filed again.
  const CANCELLABLE: readonly Step[] = ['classification', 'approval', 'investigation'];
  app.post<{ Params: { id: string } }>('/api/deviations/:id/cancel', { preHandler: requirePermission('deviations.report.cancel') }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = cancelBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request', problems: ['Give the reason why this is not a deviation.'] });
    const user = req.user as SessionUser;
    try {
      const signer = await authenticateSigner(sql, app.proofKey, user, body.data.signature,
        { objectType: 'deviation', objectId: id, meaning: 'cancelled', needs: 'deviations.report.cancel' });
      return await sql.begin(async (tx) => {
        const d = await lockHeader(tx, id);
        if (!d) return reply.code(404).send({ error: 'not_found' });
        if (!CANCELLABLE.includes(d.step)) return reply.code(409).send({ error: 'wrong_step', problems: ['Only a report not yet investigated can be cancelled as not a deviation.'] });
        if (d.reporter_id === user.id) return reply.code(403).send({ error: 'reporter_cannot_cancel', problems: ['You reported this deviation, so another QA person decides.'] });
        const [used] = await tx<{ capas: number; closed: boolean }[]>`
          select (select count(*)::int from capas where deviation_id = ${id}) as capas,
            exists (select 1 from sections where deviation_id = ${id} and kind = 'closure') as closed`;
        if (used!.capas || used!.closed) return reply.code(409).send({ error: 'wrong_step', problems: ['A CAPA was raised or the deviation was closed before: it cannot be cancelled as not a deviation.'] });
        const content = { notADeviation: true, reason: body.data.reason, stepBefore: d.step };
        const section = await addSection(tx, id, 'cancellation', content, user.id);
        await sign(tx, { signer, shownHash: contentHash('section', section.id, content), objectType: 'section', objectId: section.id, meaning: 'cancelled', content });
        await tx`update deviations set step = 'cancelled' where id = ${id}`;
        await audit(tx, { actorId: user.id, action: 'deviation.cancelled', objectType: 'deviation', objectId: id,
          old: { step: d.step }, new: { step: 'cancelled' }, reason: body.data.reason });
        return { step: 'cancelled' };
      });
    } catch (e) {
      return signFail(reply, e);
    }
  });
}

export type { ReportData };
