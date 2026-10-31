import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMonths, spikeFlags } from '../server/routes/reports.js';
import { call, freshApp, login, seedUser, type TestApp } from './helpers.js';

// S10 (D-30): one statistical flag on the trend: a month above its own c-chart limit (mean + 3 × √mean).
const rows = (key: string, counts: Record<string, number>) => Object.entries(counts).map(([month, n]) => ({ key, month, n }));

describe('unusual months (S10)', () => {
  it('S10: a month above the average of the 12 months before it plus 3 × its square root is marked, with its numbers', () => {
    // 12 months of 2 a month, then 9: mean 2, limit 2 + 3√2 = 6.2.
    const history = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [addMonths('2026-01', i), 2]));
    const s = spikeFlags(rows('Compression', { ...history, '2027-01': 9 }), '2027-01', '2027-01');
    expect(s).toEqual(expect.arrayContaining([{ key: 'Compression', month: '2027-01', n: 9, mean: 2, limit: 6.2 }]));
    // The same counts for "all deviations" (one key only).
    expect(s.find((x) => x.key === null)).toMatchObject({ n: 9 });
    // 6 is within the limit: no mark.
    expect(spikeFlags(rows('Compression', { ...history, '2027-01': 6 }), '2027-01', '2027-01')).toEqual([]);
  });

  it('S10: no mark with fewer than 6 earlier months of records, or fewer than 3 deviations in the month', () => {
    expect(spikeFlags(rows('A', { '2026-01': 1, '2026-02': 1, '2026-03': 1, '2026-04': 1, '2026-05': 9 }), '2026-05', '2026-05')).toEqual([]);
    const quiet = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [addMonths('2026-01', i), 0]));
    // Zero months before the first record do not count as history, so only months after it are used.
    expect(spikeFlags(rows('A', { ...quiet, '2026-01': 0, '2027-01': 2 }), '2027-01', '2027-01')).toEqual([]);
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-12', 13)).toBe('2027-01');
  });
});

describe('trend API (S10)', () => {
  let t: TestApp;
  beforeAll(async () => { t = await freshApp(); });
  afterAll(() => t.close());

  it('S10: the trend returns unusual months, using months before the chosen period as the baseline', async () => {
    await seedUser(t.owner, 'admin1', ['admin']);
    await seedUser(t.owner, 'us1', ['user', 'qa']);
    const admin = (await login(t.app, 'admin1')).cookie;
    const us1 = (await login(t.app, 'us1')).cookie;
    const areaId = (await call(t.app, admin, 'POST', '/api/areas', { name: 'Packing' })).json().id;
    const ids: number[] = [];
    for (let i = 0; i < 14; i++) {
      ids.push((await call(t.app, us1, 'POST', '/api/deviations', {
        planned: false, title: `Label issue ${i}`, description: 'x', areaId, eventAt: new Date(Date.now() - 600_000).toISOString(),
        products: [], noBatch: true, immediateAction: 'x',
      })).json().id);
    }
    // Spread the first 8 over the 8 months before this one (1 a month); 6 stay in this month. Test set-up only.
    for (let i = 0; i < 8; i++) await t.owner`update deviations set reported_at = now() - make_interval(months => ${i + 1}) where id = ${ids[i]!}`;
    const month = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
    const res = (await call(t.app, us1, 'GET', `/api/trends?from=${month}&to=${month}&by=area`)).json();
    expect(res.spikes).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'Packing', month, n: 6, mean: 1, limit: 4 })]));
  });
});
