import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, call, freshApp, login, seedUser, type TestApp } from './helpers.js';

// S9 (D-29): AI-suggested causes. The Gemini API is replaced by a fake, so tests never call Google.
let t: TestApp;
let off: TestApp;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};
let areaId: number;
let typeId: number;
let sent: { url: string; headers: Record<string, string>; body: { contents: { parts: { text: string }[] }[]; generationConfig: { responseMimeType: string } } }[] = [];
let answer: () => Response;

const good = {
  summary: 'Tablets were too heavy. Start with the machine settings.',
  causes: [{ category: 'machine', cause: 'Feeder speed changed', why: 'It happened after maintenance.', howToCheck: 'Look at the maintenance log and the speed setting.' }],
  questions: ['Who changed the setting?'],
  otherBatches: 'Batches made on the same press after maintenance.',
};
const gemini = (obj: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: JSON.stringify(obj) }] } }] }), { status: 200 });

beforeAll(async () => {
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return answer();
  }) as unknown as typeof fetch;
  t = await freshApp({ ai: { apiKey: 'test-key', model: 'gemini-test', fetch: fakeFetch } });
  for (const [u, roles] of [['admin1', ['admin']], ['qa1', ['qa', 'user']], ['us1', ['user']], ['us2', ['user']], ['us3', ['user']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
  areaId = (await call(t.app, c.admin1!, 'POST', '/api/areas', { name: 'Compression' })).json().id;
  typeId = (await call(t.app, c.admin1!, 'POST', '/api/deviation-types', { name: 'Equipment' })).json().id;
  off = await freshApp();
});
afterAll(async () => { await t.close(); await off.close(); });

async function inInvestigation() {
  const r = await call(t.app, c.us1!, 'POST', '/api/deviations', {
    planned: false, title: 'Tablet weight high', description: 'IPC weight 530 mg against 500 mg.', areaId, equipment: 'Press 7',
    eventAt: new Date(Date.now() - 600_000).toISOString(), products: [{ product: 'Metformin', batch: 'MET-1' }], immediateAction: 'Press stopped.',
  });
  const id = r.json().id as number;
  await call(t.app, c.qa1!, 'POST', `/api/deviations/${id}/classify`, { classification: 'major', typeId, impact: 'MET-1 only.', investigatorId: ids.us2, productBatchChecked: true });
  return id;
}
const suggest = (id: number, user = 'us2') => call(t.app, c[user]!, 'POST', `/api/deviations/${id}/ai-suggest`, {});

describe('AI suggestions (S9)', () => {
  it('S9: the investigator gets simple suggestions per fishbone category; the request is audited with what was sent and received', async () => {
    answer = () => gemini(good);
    sent = [];
    const id = await inInvestigation();
    const res = await suggest(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ model: 'gemini-test', causes: [{ category: 'machine', cause: 'Feeder speed changed' }] });
    expect(sent[0]!.url).toContain('/models/gemini-test:generateContent');
    expect(sent[0]!.headers['x-goog-api-key']).toBe('test-key');
    expect(sent[0]!.body.generationConfig.responseMimeType).toBe('application/json');
    const prompt = sent[0]!.body.contents[0]!.parts[0]!.text;
    expect(prompt).toContain('Tablet weight high');
    // No names of people are sent.
    expect(prompt).not.toMatch(/US1|US2|QA1/);
    const [row] = await t.owner`select actor_id::int, new_value from audit_log where action = 'ai.suggested' and object_id = ${String(id)}`;
    expect(row!.actor_id).toBe(ids.us2);
    expect(row!.new_value).toMatchObject({ model: 'gemini-test', received: good, failure: null, sent: { title: 'Tablet weight high' } });
  });

  it('S9: a failed or malformed AI answer gives a plain error and is audited; nothing changes in the deviation', async () => {
    const id = await inInvestigation();
    answer = () => new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
    const res = await suggest(id);
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/could not be fetched/);
    answer = () => gemini({ summary: 'x' });
    expect((await suggest(id)).statusCode).toBe(502);
    const rows = await t.owner`select new_value->>'failure' as failure from audit_log where action = 'ai.suggested' and object_id = ${String(id)} order by id`;
    expect(rows.map((r) => r.failure)).toEqual([expect.stringMatching(/429/), expect.stringMatching(/expected form/)]);
    const d = (await call(t.app, c.qa1!, 'GET', `/api/deviations/${id}`)).json();
    expect(d.step).toBe('investigation');
    expect(d.sections.filter((s: { kind: string }) => s.kind === 'investigation')).toHaveLength(0);
  });

  it('S9: only the investigator or QA asks, and only during the investigation; Admin never', async () => {
    answer = () => gemini(good);
    const id = await inInvestigation();
    expect((await suggest(id, 'us3')).statusCode).toBe(403);
    expect((await suggest(id, 'admin1')).statusCode).toBe(403);
    expect((await suggest(id, 'qa1')).statusCode).toBe(200);
    const r = await call(t.app, c.us1!, 'POST', '/api/deviations', {
      planned: false, title: 'Not yet classified', description: 'x', areaId, eventAt: new Date(Date.now() - 600_000).toISOString(), noBatch: true, products: [], immediateAction: 'x',
    });
    expect((await suggest(r.json().id, 'qa1')).statusCode).toBe(409);
  });

  it('S9: without a Gemini key the feature is off and says so', async () => {
    await seedUser(off.owner, 'qa9', ['qa', 'user']);
    const cookie = (await login(off.app, 'qa9')).cookie;
    expect((await call(off.app, cookie, 'GET', '/api/ai/status')).json()).toEqual({ enabled: false, model: null });
    expect((await call(off.app, cookie, 'POST', '/api/deviations/1/ai-suggest', {})).statusCode).toBe(503);
    expect((await call(t.app, c.us2!, 'GET', '/api/ai/status')).json()).toEqual({ enabled: true, model: 'gemini-test' });
  });
});
