import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requireRole, type SessionUser } from '../auth.js';
import { FISHBONE } from '../deviations.js';
import { computeSignals } from './signals.js';

// S9 (D-27, D-29): possible causes suggested by an AI model (Google Gemini), in very simple language.
// Advice only: nothing is saved in the deviation. The investigator writes and signs the root cause
// (211.192, SchM 1.5(s)). Every request is audited with exactly what was sent and what came back.
export interface AiOptions { apiKey: string; model: string; fetch?: typeof fetch; timeoutMs?: number }

const CATEGORIES = FISHBONE.map(([k]) => k) as [string, ...string[]];
export const suggestionSchema = z.object({
  summary: z.string().max(2000),
  causes: z.array(z.object({
    category: z.enum(CATEGORIES),
    cause: z.string().max(500),
    why: z.string().max(1000),
    howToCheck: z.string().max(1000),
  })).max(15),
  questions: z.array(z.string().max(500)).max(10),
  otherBatches: z.string().max(1000),
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

export function aiRoutes(app: FastifyInstance, sql: Sql, ai?: AiOptions) {
  const actor = { preHandler: requireRole('user', 'qa') };

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
    if (d.investigator_id !== user.id && !user.roles.includes('qa')) return reply.code(403).send({ error: 'not_investigator' });

    const signals = await computeSignals(sql, id);
    // What is sent: the facts of this deviation and the rule-based hints. No names of people.
    const facts = {
      title: d.report.title, whatHappened: d.report.description, area: d.area, equipment: d.report.equipment || null,
      whenItHappened: d.report.eventAt, productsAndBatches: d.report.products, immediateAction: d.report.immediateAction,
      planned: d.report.planned, classification: d.cls?.classification ?? null, type: d.type, impactAssessment: d.cls?.impact ?? null,
      hintsFromRules: signals?.flags.map((f) => f.text) ?? [],
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
        signal: AbortSignal.timeout(ai.timeoutMs ?? 90_000),
      });
      const json = (await res.json().catch(() => ({}))) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]; error?: { message?: string } };
      if (!res.ok) throw new Error(`AI service answered ${res.status}: ${json.error?.message ?? 'no detail'}`);
      const text = (json.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
      const parsed = suggestionSchema.safeParse(JSON.parse(text));
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
