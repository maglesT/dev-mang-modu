import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMonths, spikeFlags } from '../server/routes/reports.js';
import { call, freshApp, login, seedUser, type TestApp } from './helpers.js';

// S10 (D-30): one statistical flag on the trend: a month above its own c-chart limit (mean + 3 × √mean).
const rows = (key: string, counts: Record<string, number>) => Object.entries(counts).map(([month, n]) => ({ key, month, n }));

describe('unusual months (S10)', () => {
  it('S10: a month above the average of the 12 months before it plus 3 × its square root is marked, with its numbers', () => {
    // 12 months of 2 a month, then 9: mean 2, limit 2 + 3√2 = 6.24, shown as 6.2.
    const history = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [addMonths('2026-01', i), 2]));
    const s = spikeFlags(rows('Compression', { ...history, '2027-01': 9 }), '2027-01', '2027-01', '2026-01');
    expect(s).toEqual(expect.arrayContaining([{ key: 'Compression', month: '2027-01', n: 9, mean: 2, limit: 6.2 }]));
    // The same counts for "all deviations" (one key only).
    expect(s.find((x) => x.key === null)).toMatchObject({ n: 9 });
    // 6 is within the limit: no mark.
    expect(spikeFlags(rows('Compression', { ...history, '2027-01': 6 }), '2027-01', '2027-01', '2026-01')).toEqual([]);
  });

  it('S10: quiet months after the first record count as 0; months before it do not count; fewer than 3 is never marked', () => {
    // Records since 2025-01, nothing for a year, then 3: average 0, limit 0, so it is marked.
    expect(spikeFlags(rows('A', { '2027-01': 3 }), '2027-01', '2027-01', '2025-01')).toEqual(
      expect.arrayContaining([{ key: 'A', month: '2027-01', n: 3, mean: 0, limit: 0 }]));
    // The same counts on a site whose records start in 2026-10: fewer than 6 earlier months, no mark.
    expect(spikeFlags(rows('A', { '2026-10': 1, '2027-01': 9 }), '2027-01', '2027-01', '2026-10')).toEqual([]);
    expect(spikeFlags(rows('A', { '2027-01': 2 }), '2027-01', '2027-01', '2025-01')).toEqual([]);
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
