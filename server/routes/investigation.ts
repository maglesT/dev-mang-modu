import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requireRole, type SessionUser } from '../auth.js';
import { authenticateSigner, contentHash, sign, signBody, SignError } from '../signatures.js';
import {
  addSection, classificationData, investigationData, latestId, recomputeStep, reportData, targetDate, writeBatches,
  type ClassificationData, type InvestigationData, type ReportData, type Step,
} from '../deviations.js';

const credentials = signBody.omit({ contentHash: true });
const investigateBody = z.object({ data: z.unknown(), signature: credentials });
const correctBody = z.object({ kind: z.enum(['report', 'classification', 'investigation']), data: z.unknown(), reason: z.string().trim().min(1).max(2000) });
const uploadBody = z.object({
  filename: z.string().trim().min(1).max(200),
  mime: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
  dataBase64: z.string().min(1).max(14_000_000),
});
const reasonBody = z.object({ reason: z.string().trim().min(1).max(2000) });

interface Header { id: number; planned: boolean; reporter_id: number; step: Step; classification: string | null; investigator_id: number | null }
const lockHeader = async (tx: Tx, id: number) =>
  (await tx<Header[]>`select id::int, planned, reporter_id::int, step, classification, investigator_id::int
    from deviations where id = ${id} for update`)[0];


const problems = (e: z.ZodError) => e.issues.map((i) => i.message);
const signFail = (reply: FastifyReply, e: unknown) => {
  if (e instanceof SignError) return reply.code(e.code === 'wrong_credentials' ? 401 : e.code === 'not_allowed' ? 403 : 409).send({ error: e.code });
  throw e;
};
const otherRows = (d: InvestigationData) => d.otherBatches.map((b) => ({ product: b.product, batch: b.batch, outcome: b.outcome, role: 'other' as const }));

export function investigationRoutes(app: FastifyInstance, sql: Sql) {
  const actor = { preHandler: requireRole('user', 'qa') };

  // DV-04 to DV-07: the investigator (or QA) writes and signs the investigation in one step.
  app.post<{ Params: { id: string } }>('/api/deviations/:id/investigate', actor, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = investigateBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const data = investigationData.safeParse(body.data.data);
    if (!data.success) return reply.code(400).send({ error: 'invalid_request', problems: problems(data.error) });
    const user = req.user as SessionUser;
    try {
      const signer = await authenticateSigner(sql, user, { ...body.data.signature, contentHash: '0'.repeat(64) }, { objectType: 'deviation', objectId: id, meaning: 'investigation_complete' });
      return await sql.begin(async (tx) => {
        const d = await lockHeader(tx, id);
        if (!d) return reply.code(404).send({ error: 'not_found' });
        if (d.step !== 'investigation') return reply.code(409).send({ error: 'wrong_step' });
        if (d.investigator_id !== user.id && !user.roles.includes('qa')) return reply.code(403).send({ error: 'not_investigator' });
        if (await latestId(tx, id, 'investigation')) return reply.code(409).send({ error: 'already_investigated' });
        const section = await addSection(tx, id, 'investigation', data.data, user.id);
        await writeBatches(tx, id, section.id, otherRows(data.data));
        // The signer submitted this content in the same request, so the hash shown is the hash of what was sent.
        const shown = contentHash('section', section.id, data.data);
        await sign(tx, { signer, shownHash: shown, objectType: 'section', objectId: section.id, meaning: 'investigation_complete', content: data.data });
        await tx`update deviations set step = 'closure' where id = ${id}`;
        await audit(tx, { actorId: user.id, action: 'deviation.investigated', objectType: 'section', objectId: section.id, new: data.data });
        return { step: 'closure' };
      });
    } catch (e) {
      return signFail(reply, e);
    }
  });

  // Signs the latest investigation version again after a correction (DV-14, DV-16).
  app.post<{ Params: { id: string } }>('/api/deviations/:id/investigation/sign', actor, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = signBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const user = req.user as SessionUser;
    try {
      const signer = await authenticateSigner(sql, user, body.data, { objectType: 'deviation', objectId: id, meaning: 'investigation_complete' });
      return await sql.begin(async (tx) => {
        const d = await lockHeader(tx, id);
        if (!d) return reply.code(404).send({ error: 'not_found' });
        if (d.step !== 'investigation') return reply.code(409).send({ error: 'wrong_step' });
        if (d.investigator_id !== user.id && !user.roles.includes('qa')) return reply.code(403).send({ error: 'not_investigator' });
        const [s] = await tx<{ id: number; data: unknown }[]>`select id::int, data from latest_sections where deviation_id = ${id} and kind = 'investigation'`;
        if (!s) return reply.code(409).send({ error: 'wrong_step' });
        await sign(tx, { signer, shownHash: body.data.contentHash, objectType: 'section', objectId: s.id, meaning: 'investigation_complete', content: s.data });
        const step = await recomputeStep(tx, d);
        await tx`update deviations set step = ${step} where id = ${id}`;
        return { step };
      });
    } catch (e) {
      return signFail(reply, e);
    }
  });

  // DV-14: a correction is a new version with a reason; the audit trail records who and when.
  app.post<{ Params: { id: string } }>('/api/deviations/:id/correct', actor, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = correctBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request', problems: body.success ? [] : ['Give the reason for the correction.'] });
    const { kind, reason } = body.data;
    const schema = kind === 'report' ? reportData : kind === 'classification' ? classificationData : investigationData;
    const data = schema.safeParse(body.data.data);
    if (!data.success) return reply.code(400).send({ error: 'invalid_request', problems: problems(data.error) });
    const user = req.user as SessionUser;
    const isQa = user.roles.includes('qa');
    const out = await sql.begin(async (tx) => {
      const d = await lockHeader(tx, id);
      if (!d) return { status: 404, error: 'not_found' };
      // A closed or rejected deviation is reopened first; it is never edited in place.
      if (d.step === 'closed' || d.step === 'rejected') return { status: 409, error: 'closed' };
      const before = await tx<{ id: number; data: unknown }[]>`select id::int, data from latest_sections where deviation_id = ${id} and kind = ${kind}`;
      if (!before[0]) return { status: 409, error: 'nothing_to_correct' };
      const allowed =
        kind === 'report' ? d.reporter_id === user.id || isQa
        : kind === 'classification' ? isQa && d.reporter_id !== user.id
        : d.investigator_id === user.id || isQa;
      if (!allowed) return { status: 403, error: 'forbidden' };
      if (kind === 'report' && (data.data as ReportData).planned !== d.planned) return { status: 400, error: 'invalid_request', problems: ['Planned or unplanned cannot be changed.'] };

      if (kind === 'report') {
        const [area] = await tx`select 1 from areas where id = ${(data.data as ReportData).areaId} and active`;
        if (!area) return { status: 400, error: 'invalid_request', problems: ['Choose an area from the list.'] };
      }
      if (kind === 'classification') {
        // The same checks as the first classification (DV-03, D-08: Admin never investigates).
        const c = data.data as ClassificationData;
        const [type] = await tx`select 1 from deviation_types where id = ${c.typeId} and active`;
        const [inv] = await tx`select 1 from users u where u.id = ${c.investigatorId} and u.active and u.locked_at is null
          and exists (select 1 from user_roles r where r.user_id = u.id and r.role in ('user', 'qa'))`;
        if (!type || !inv) return { status: 400, error: 'invalid_request', problems: ['Choose a deviation type and an investigator from the lists.'] };
      }
      const section = await addSection(tx, id, kind, data.data, user.id, reason);
      if (kind === 'report') {
        const r = data.data as ReportData;
        await writeBatches(tx, id, section.id, r.products.map((p) => ({ ...p, role: 'own' as const })));
        // The approval of a planned deviation covers the report; a new classification version carries the renewed approval.
        const cls = await tx<{ data: unknown }[]>`select data from latest_sections where deviation_id = ${id} and kind = 'classification'`;
        if (d.planned && cls[0]) await addSection(tx, id, 'classification', cls[0].data, user.id, 'Report corrected: approval to be renewed');
      } else if (kind === 'classification') {
        const c = data.data as ClassificationData;
        const target = c.classification !== d.classification ? await targetDate(tx, id, c.classification) : null;
        await tx`update deviations set classification = ${c.classification}, investigator_id = ${c.investigatorId}
          ${target ? tx`, target_date = ${target}` : tx``} where id = ${id}`;
      } else {
        await writeBatches(tx, id, section.id, otherRows(data.data as InvestigationData));
      }
      const step = await recomputeStep(tx, { ...d, step: d.step });
      await tx`update deviations set step = ${step} where id = ${id}`;
      await audit(tx, { actorId: user.id, action: `deviation.${kind}_corrected`, objectType: 'section', objectId: section.id,
        old: before[0].data, new: data.data, reason });
      return { status: 200, step };
    });
    if (out.status !== 200) return reply.code(out.status).send(out);
    return { step: out.step };
  });

  // Attachments: PDF or image files up to 10 MB, kept in the database with their SHA-256 (DV-21, DV-22).
  app.post<{ Params: { id: string } }>('/api/deviations/:id/attachments', { ...actor, bodyLimit: 15 * 1024 * 1024 }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = uploadBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const bytes = Buffer.from(body.data.dataBase64, 'base64');
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) return reply.code(400).send({ error: 'invalid_request', problems: ['Files can be at most 10 MB.'] });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const out = await sql.begin(async (tx) => {
      const d = await lockHeader(tx, id);
      if (!d) return null;
      if (d.step === 'closed' || d.step === 'rejected') return 'closed' as const;
      const [a] = await tx<{ id: number }[]>`
        insert into attachments (deviation_id, filename, mime, size, sha256, data, uploaded_by)
        values (${id}, ${body.data.filename}, ${body.data.mime}, ${bytes.length}, ${sha256}, ${bytes}, ${req.user!.id}) returning id::int`;
      await audit(tx, { actorId: req.user!.id, action: 'attachment.added', objectType: 'deviation', objectId: id,
        new: { attachmentId: a!.id, filename: body.data.filename, size: bytes.length, sha256 } });
      return a!.id;
    });
    if (out === null) return reply.code(404).send({ error: 'not_found' });
    if (out === 'closed') return reply.code(409).send({ error: 'closed' });
    return reply.code(201).send({ id: out, sha256 });
  });

  app.get<{ Params: { id: string } }>('/api/attachments/:id', { preHandler: requireRole() }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const [a] = await sql<{ filename: string; mime: string; data: Buffer }[]>`select filename, mime, data from attachments where id = ${id}`;
    if (!a) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', a.mime)
      .header('content-disposition', `attachment; filename="${a.filename.replace(/[^\w.\- ]/g, '_')}"`)
      .header('x-content-type-options', 'nosniff')
      .send(a.data);
  });

  // DV-14: withdrawing keeps the file; only the uploader or QA may withdraw, with a reason.
  app.post<{ Params: { id: string } }>('/api/attachments/:id/withdraw', actor, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = reasonBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const out = await sql.begin(async (tx) => {
      const [a] = await tx<{ deviation_id: number; uploaded_by: number; step: Step; withdrawn: boolean }[]>`
        select a.deviation_id::int, a.uploaded_by::int, d.step,
          exists (select 1 from attachment_withdrawals w where w.attachment_id = a.id) as withdrawn
        from attachments a join deviations d on d.id = a.deviation_id where a.id = ${id} for update of d`;
      if (!a) return 404;
      if (a.withdrawn || a.step === 'closed' || a.step === 'rejected') return 409;
      if (a.uploaded_by !== req.user!.id && !req.user!.roles.includes('qa')) return 403;
      await tx`insert into attachment_withdrawals (attachment_id, reason, withdrawn_by) values (${id}, ${body.data.reason}, ${req.user!.id})`;
      await audit(tx, { actorId: req.user!.id, action: 'attachment.withdrawn', objectType: 'deviation', objectId: a.deviation_id,
        new: { attachmentId: id }, reason: body.data.reason });
      return 200;
    });
    if (out !== 200) return reply.code(out).send({ error: out === 404 ? 'not_found' : out === 403 ? 'forbidden' : 'wrong_step' });
    return { ok: true };
  });
}

