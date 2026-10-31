import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, apiAs, logIn, logOut, post } from './helpers.js';
import { TOOLS } from '../test/fixtures.js';

const inDays = (n: number) => new Date(Date.now() + n * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);

// A major deviation investigated and signed, waiting for closure (set up through the API).
async function awaitingClosure(batch: string) {
  const us1 = await apiAs('us1');
  const areas = await (await us1.get('/api/areas')).json();
  const { id, number } = await post(us1, '/api/deviations', {
    planned: false, title: 'Leaflet rev 3 in line', description: 'Old leaflet revision found.', areaId: areas[1].id,
    eventAt: new Date(Date.now() - 600_000).toISOString(), products: [{ product: 'Amlodipine 5 mg', batch }], initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'Line stopped.',
  });
  await us1.dispose();
  const qa = await apiAs('qa1');
  const types = await (await qa.get('/api/deviation-types')).json();
  const people = await (await qa.get('/api/people')).json();
  await post(qa, `/api/deviations/${id}/classify`, {
    classification: 'major', typeId: types[0].id, impact: 'This batch.', investigatorId: people.find((p: { username: string }) => p.username === 'us2').id, productBatchChecked: true,
  });
  await qa.dispose();
  const us2 = await apiAs('us2');
  await post(us2, `/api/deviations/${id}/investigate`, {
    data: { ...TOOLS, rootCause: 'Old stock not removed.', otherBatches: [], noOtherReason: 'Only this line had rev 3.', conclusion: 'Repack.' },
    signature: { username: 'us2', password: PASSWORD },
  });
  await us2.dispose();
  return number as string;
}

async function sign(page: Page, username: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('User ID').fill(username);
  await dialog.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign' }).click();
}

test('main flow: QA raises a CAPA, closes the deviation with the CAPA still open; the owner and QA then close the CAPA', async ({ page }) => {
  const number = await awaitingClosure(`AML-${Date.now().toString(36)}`);
  await logIn(page, 'qa1');
  await page.getByRole('button', { name: number }).click();
  await expect(page.locator('.statusbar')).toContainText('Awaiting closure');

  // DV-08: a major deviation needs a CAPA before closure.
  await page.getByLabel('Closure summary *').fill('Batch repacked with rev 4 leaflets.');
  await page.getByRole('button', { name: 'Sign closed' }).click();
  await expect(page.getByText('A major or critical deviation needs at least one CAPA before closure.')).toBeVisible();

  await page.getByRole('button', { name: 'Raise a CAPA' }).click();
  await page.getByLabel('What must be done').fill('Remove rev 3 leaflets from stores.');
  await page.getByLabel('Owner').selectOption({ label: 'US1 (us1)' });
  await page.getByLabel('Due date').fill(inDays(14));
  await page.getByLabel('Strength').selectOption('medium');
  await page.getByRole('button', { name: 'Raise CAPA' }).click();
  await expect(page.getByRole('row', { name: /CAPA-/ })).toContainText('Open');

  // D-14: open CAPAs do not block closure.
  await page.getByRole('button', { name: 'Sign closed' }).click();
  await sign(page, 'qa1');
  await expect(page.locator('.statusbar')).toContainText('Closed');
  await expect(page.getByText('1 still open (followed in the CAPA list)')).toBeVisible();
  const capa = (await page.getByRole('row', { name: /CAPA-/ }).getByRole('button').first().textContent())!;
  await logOut(page);

  await logIn(page, 'us1');
  await page.getByRole('button', { name: 'CAPAs', exact: true }).click();
  await page.getByRole('button', { name: capa }).click();
  await page.getByLabel('What was done (with record references)').fill('Rev 3 stock destroyed, record DR-55.');
  await page.getByRole('button', { name: 'Mark done' }).click();
  await expect(page.locator('.statusbar')).toContainText('Done · awaiting QA');
  await logOut(page);

  await logIn(page, 'qa2');
  await page.getByRole('button', { name: 'CAPAs', exact: true }).click();
  await page.getByRole('button', { name: capa }).click();
  await page.getByLabel('Monitored through the trend and quality review (closes the CAPA now)').check();
  await page.getByLabel('Why no dedicated check is needed').fill('Low risk; recurrence seen in the yearly review.');
  await page.getByRole('button', { name: 'Sign verified' }).click();
  await sign(page, 'qa2');
  await expect(page.locator('.statusbar')).toContainText('Closed');
});

test('DV-08: QA enters a CAPA directly for an internal audit finding', async ({ page }) => {
  await logIn(page, 'qa1');
  await page.getByRole('button', { name: 'CAPAs', exact: true }).click();
  await page.getByRole('button', { name: 'New CAPA (audit, complaint, other)' }).click();
  await page.getByLabel(/^Reference/).fill('IA-2026-07 finding 3');
  await page.getByLabel('Preventive').check();
  await page.getByLabel('What must be done').fill('Add leaflet revision check to line clearance checklist.');
  await page.getByLabel('Owner').selectOption({ label: 'US1 (us1)' });
  await page.getByLabel('Due date').fill(inDays(30));
  await page.getByLabel('Strength').selectOption('medium');
  await page.getByRole('button', { name: 'Raise CAPA' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Preventive action');
  await expect(page.getByText('Internal audit: IA-2026-07 finding 3')).toBeVisible();
});
