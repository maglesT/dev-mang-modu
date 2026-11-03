import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { can, parseId, requirePermission, type SessionUser } from '../auth.js';
import { FISHBONE } from '../deviations.js';
import { computeSignals } from './signals.js';

// S9 (D-27, D-29): possible causes suggested by an AI model (Google Gemini), in very simple language.
// Advice only: nothing is saved in the deviation. The investigator writes and signs the root cause
// (211.192, SchM 1.5(s)). Every request is audited with exactly what was sent and what came back.
export interface AiOptions { apiKey: string; model: string; fetch?: typeof fetch; timeoutMs?: number }

const CATEGORIES = FISHBONE.map(([k]) => k) as [string, ...string[]];
// Over-long text is shortened rather than rejected, so one long sentence does not lose the whole answer.
const cut = (n: number) => z.string().transform((v) => v.slice(0, n));
// Fits a fishbone box (2000 characters, server/deviations.ts) with room to spare.
export const CAUSE_MAX = 300;
export const suggestionSchema = z.object({
  summary: cut(2000),
  causes: z.array(z.object({
    category: z.enum(CATEGORIES),
    cause: cut(CAUSE_MAX),
    why: cut(1000),
    howToCheck: cut(1000),
  })).transform((v) => v.slice(0, 10)),
  questions: z.array(cut(500)).transform((v) => v.slice(0, 8)),
  otherBatches: cut(1000),
});
export type Suggestion = z.infer<typeof suggestionSchema>;

// The same shape for Gemini's structured output (OpenAPI subset).
const str = { type: 'STRING' };
const responseSchema = {
  type: 'OBJECT',
  properties: {
    summary: str,
    causes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { category: { type: 'STRING', enum: CATEGORIES }, cause: str, why: str, howToCheck: str }, required: ['category', 'cause', 'why', 'howToCheck'] } },
    questions: { type: 'ARRAY', items: str },
    otherBatches: str,
  },
  required: ['summary', 'causes', 'questions', 'otherBatches'],
};

const INSTRUCTION = `You help a person in a pharmaceutical factory investigate a deviation (something that did not go as planned).
Write in very simple English: short sentences, everyday words, no jargon. Explain any technical word you must use.
Write as if explaining to a new operator who has never done an investigation.
Your job is to suggest, not to decide. Never say what the root cause is; give possible causes to check.
For each possible cause give: the fishbone category (man = people, machine = equipment, method, material, measurement, environment),
the cause in a few words, why it could fit what happened, and how to check it on the shop floor or in the records.
Give 3 to 8 causes, the most likely first. Use the earlier similar cases if they help, and say so.
"summary": two or three sentences on what happened and where to start.
"questions": up to 6 simple questions to ask the people involved.
"otherBatches": one or two sentences on which other batches or products could also be affected and why.
Only use the facts given. If something important is missing, say what to find out.`;

// A paid call: at most this many requests per person per hour, counted from the audit trail.
const PER_HOUR = 10;

export function aiRoutes(app: FastifyInstance, sql: Sql, ai?: AiOptions) {
  const actor = { preHandler: requirePermission('deviations.investigation.write') };

  // Lets the screen show or hide the button.
  app.get('/api/ai/status', actor, async () => ({ enabled: !!ai, model: ai?.model ?? null }));

  app.post<{ Params: { id: string } }>('/api/deviations/:id/ai-suggest', actor, async (req, reply) => {
    if (!ai) return reply.code(503).send({ error: 'ai_not_configured' });
    const id = parseId(req.params.id);
    if (id === null) return reply.code(400).send({ error: 'invalid_request' });
    const user = req.user as SessionUser;
    const [d] = await sql<{ number: string; step: string; investigator_id: number | null; report: Record<string, unknown>; cls: Record<string, unknown> | null; area: string | null; type: string | null }[]>`
      select d.number, d.step, d.investigator_id::int, r.data as report, c.data as cls, a.name as area, t.name as type
      from deviations d join latest_sections r on r.deviation_id = d.id and r.kind = 'report'
      left join latest_sections c on c.deviation_id = d.id and c.kind = 'classification'
      left join areas a on a.id::text = r.data->>'areaId'
      left join deviation_types t on t.id::text = c.data->>'typeId'
      where d.id = ${id}`;
    if (!d) return reply.code(404).send({ error: 'not_found' });
    // The person investigating (or QA) asks while the investigation is open.
    if (d.step !== 'investigation') return reply.code(409).send({ error: 'wrong_step' });
    if (d.investigator_id !== user.id && !can(user, 'deviations.qa.oversee')) return reply.code(403).send({ error: 'not_investigator' });

    const [used] = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_log where action = 'ai.suggested' and actor_id = ${user.id} and at > now() - interval '1 hour'`;
    if (used!.n >= PER_HOUR) return reply.code(429).send({ error: 'too_many', message: `You can ask the AI ${PER_HOUR} times an hour. Please try again later.` });

    const signals = await computeSignals(sql, id);
    // What is sent: the facts of this deviation and the rule-based hints. The reporter's, investigator's and
    // other users' names are not sent; free text is sent as written (D-29).
    const facts = {
      title: d.report.title, whatHappened: d.report.description, area: d.area, equipment: d.report.equipment || null,
      whenItHappened: d.report.eventAt, productsAndBatches: d.report.products, immediateAction: d.report.immediateAction, reportersInitialImpact: d.report.initialImpact ?? null,
      planned: d.report.planned, classification: d.cls?.classification ?? null, type: d.type, impactAssessment: d.cls?.impact ?? null,
      hintsFromRules: signals?.flags.map((f) => f.text) ?? [],
      // S17: what the latest fetch from the batch record and the Logbook showed (plain-words findings only).
      dataFindings: (await sql<{ source: string; findings: string[] | null }[]>`
        select distinct on (source) source, data->'findings' as findings from data_fetches
        where deviation_id = ${id} and status = 'ok' order by source, id desc`).map((r) => ({ source: r.source, findings: r.findings ?? [] })),
      similarEarlierCases: signals?.similar.map((s) => ({ title: s.title, rootCause: s.rootCause, causes: s.causes, capas: s.capas.map((c) => c.description) })) ?? [],
    };
    const body = {
      systemInstruction: { parts: [{ text: INSTRUCTION }] },
      contents: [{ role: 'user', parts: [{ text: `Deviation facts (JSON):\n${JSON.stringify(facts, null, 2)}` }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema, temperature: 0.4 },
    };

    let suggestion: Suggestion | null = null;
    let failure: string | null = null;
    try {
      const res = await (ai.fetch ?? fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': ai.apiKey },
        body: JSON.stringify(body),
        // Below the usual 60 s reverse-proxy limit, so the browser sees the real outcome.
        signal: AbortSignal.timeout(ai.timeoutMs ?? 55_000),
      });
      const json = (await res.json().catch(() => ({}))) as {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
        promptFeedback?: { blockReason?: string }; error?: { message?: string };
      };
      if (!res.ok) throw new Error(`AI service answered ${res.status}: ${json.error?.message ?? 'no detail'}`);
      const first = json.candidates?.[0];
      if (!first) throw new Error(`No answer from the AI service${json.promptFeedback?.blockReason ? ` (blocked: ${json.promptFeedback.blockReason})` : ''}.`);
      const text = (first.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { throw new Error(`The AI answer was not complete JSON (finish reason: ${first.finishReason ?? 'none'}).`); }
      const parsed = suggestionSchema.safeParse(raw);
      if (!parsed.success) throw new Error('The AI answer was not in the expected form.');
      suggestion = parsed.data;
    } catch (e) {
      failure = e instanceof Error ? e.message.slice(0, 500) : 'unknown error';
    }
    // DV-15: who asked, when, which model, what was sent and what came back (or why it failed).
    await audit(sql, { actorId: user.id, action: 'ai.suggested', objectType: 'deviation', objectId: id, new: { model: ai.model, sent: facts, received: suggestion, failure } });
    if (!suggestion) return reply.code(502).send({ error: 'ai_failed', message: 'The AI suggestions could not be fetched. Please try again later.' });
    return { model: ai.model, ...suggestion };
  });
}
