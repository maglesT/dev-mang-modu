import { expect, test } from '@playwright/test';
import { apiAs, logIn, post } from './helpers.js';

test('DV-11: a deviation affecting a batch is listed for that batch, flagged as open', async ({ page }) => {
  const batch = `REL-${Date.now().toString(36)}`;
  const us1 = await apiAs('us1');
  const areas = await (await us1.get('/api/areas')).json();
  const { number } = await post(us1, '/api/deviations', {
    planned: false, title: 'Granule LOD high', description: 'LOD 3.5% vs NMT 3%.', areaId: areas[0].id,
    eventAt: new Date(Date.now() - 600_000).toISOString(), products: [{ product: 'Paracetamol 500 mg', batch }], initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'Re-dried.',
  });
  await us1.dispose();
  await logIn(page, 'qa2');
  await page.getByRole('button', { name: 'Batch check & trends' }).click();
  await page.getByLabel('Batch number').fill(batch.toLowerCase());
  await page.getByRole('button', { name: 'Check batch' }).click();
  await expect(page.getByText('1 open deviation concerns this batch')).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(number) })).toContainText('Awaiting classification');
});

test('DV-12: the trend shows counts per month as a chart and a table', async ({ page }) => {
  await logIn(page, 'qa1');
  await page.getByRole('button', { name: 'Batch check & trends' }).click();
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(page.getByRole('img', { name: 'Deviations reported per month' })).toBeVisible();
  await expect(page.locator('table.trend tr.total')).toContainText('All deviations');
  // S10: the unusual-months box explains its rule in plain words.
  await expect(page.getByRole('region', { name: 'Unusual months' })).toContainText('a reason to look, not a conclusion');
});

test('DV-21: the deviation page offers a PDF copy', async ({ page }) => {
  const us1 = await apiAs('us1');
  const areas = await (await us1.get('/api/areas')).json();
  const { number, id } = await post(us1, '/api/deviations', {
    planned: false, title: 'PDF check', description: 'x', areaId: areas[0].id, eventAt: new Date(Date.now() - 600_000).toISOString(),
    products: [], noBatch: true, initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'x',
  });
  await us1.dispose();
  await logIn(page, 'us1');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('button', { name: number }).click();
  await expect(page.getByRole('link', { name: 'Print PDF' })).toHaveAttribute('href', `/api/deviations/${id}/pdf`);
  const res = await page.request.get(`/api/deviations/${id}/pdf`);
  expect(res.headers()['content-type']).toBe('application/pdf');
});
