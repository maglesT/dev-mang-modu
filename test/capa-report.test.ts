import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshApp, login, seedUser, type TestApp } from './helpers.js';

// D-39: report.capa_v1 for the QMS product: read-only, CAPA register only.
let t: TestApp;
let schema: string;
const c: Record<string, string> = {};
const ids: Record<string, number> = {};

beforeAll(async () => {
  t = await freshApp();
  schema = (await t.owner<{ schema: string }[]>`select current_schema() as schema`)[0]!.schema;
  for (const [u, roles] of [['admin1', ['admin']], ['qa1', ['qa', 'user']], ['us1', ['user']]] as const) {
    ids[u] = await seedUser(t.owner, u, [...roles]);
    c[u] = (await login(t.app, u)).cookie;
  }
});
afterAll(() => t.close());

describe('CAPA report view (D-39)', () => {
  it('DV-08: report.capa_v1 lists each CAPA with its status, due date, deviation number and latest description', async () => {
    const r = await call(t.app, c.qa1!, 'POST', '/api/capas', { source: 'audit', sourceRef: 'IA-2026-07 finding 3', type: 'preventive', strength: 'strong', description: 'Interlock the FBD timer', ownerId: ids.us1, dueDate: '2030-01-15' });
    expect(r.statusCode, r.body).toBe(201);
    const rows = await t.owner.unsafe(`select number, status, due_date::text, deviation_number, description, source from ${schema}_report.capa_v1`);
    expect(rows).toEqual([{ number: r.json().number, status: 'open', due_date: '2030-01-15', deviation_number: null, description: 'Interlock the FBD timer', source: 'audit' }]);
  });

  it('DV-15: capa_report reads the view only: no table, no write, no temporary objects', async () => {
    // Each statement runs as capa_report in its own transaction; the error text (if any) is returned.
    const asReport = (q: string) => t.owner.begin(async (tx) => {
      await tx.unsafe('set local role capa_report');
      return (await tx.unsafe(q)) as unknown;
    }).then((r) => ({ ok: true as const, r }), (e: Error) => ({ ok: false as const, error: e.message }));
    const read = await asReport(`select count(*)::int as n from ${schema}_report.capa_v1`);
    expect(read.ok && (read.r as { n: number }[])[0]!.n).toBeGreaterThan(0);
    for (const q of [`select * from ${schema}.capas`, `select * from ${schema}.audit_log`, `delete from ${schema}_report.capa_v1`, 'create temporary table x (a int)']) {
      const r = await asReport(q);
      expect(r.ok, q).toBe(false);
      expect(!r.ok && r.error, q).toMatch(/permission denied|cannot delete/);
    }
  });
});
