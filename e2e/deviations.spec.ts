import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, logIn, logOut, owner } from './helpers.js';

async function report(page: Page, title: string, batch: string, planned = false) {
  await page.getByRole('button', { name: 'Report a deviation' }).click();
  if (planned) {
    await page.getByLabel('It is planned (needs QA approval first)').check();
    await page.getByLabel('Reason for the planned deviation *').fill('Alternate sieve while the usual one is repaired.');
  }
  await page.getByLabel('Title *').fill(title);
  await page.getByLabel('What happened *').fill('The mixer stopped for ten minutes after a power dip.');
  await page.getByLabel('Area *').selectOption({ label: 'Granulation' });
  await page.getByLabel('Product 1').fill('Paracetamol 500 mg');
  await page.getByLabel('Batch 1').fill(batch);
  // S12: the reporter's initial impact assessment.
  await page.getByRole('radiogroup', { name: 'Could product quality be affected?' }).getByLabel('Not known yet').check();
  await page.getByRole('radiogroup', { name: 'Could patient safety be at risk?' }).getByLabel('No', { exact: true }).check();
  await page.getByRole('radiogroup', { name: 'Could other batches be affected?' }).getByLabel('No', { exact: true }).check();
  await page.getByLabel('Short assessment *').fill('Granules held 10 minutes; moisture to be checked.');
  await page.getByLabel('Action taken (immediate action) *').fill('Restarted after informing QA.');
  await page.getByRole('button', { name: 'Save and get a number' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
  return (await page.getByRole('heading', { level: 1 }).textContent())!.split(' · ')[0]!;
}

async function classify(page: Page, number: string, level = 'Major') {
  await page.getByRole('button', { name: number }).click();
  await page.getByLabel(level).check();
  await page.getByLabel('Type').selectOption({ label: 'Process' });
  await page.getByLabel('Investigator').selectOption({ label: 'US2 (us2)' });
  await page.getByLabel(/^Impact assessment/).fill('Check granule moisture of this batch.');
  await page.getByLabel('I checked the product and batch numbers against the batch record').check();
  await page.getByRole('button', { name: 'Save classification' }).click();
}

test('DV-01, DV-03: a user reports a deviation, QA classifies it, the investigator sees it waiting', async ({ page }) => {
  await logIn(page, 'us1');
  const batch = `PCM-${Date.now().toString(36)}`;
  const number = await report(page, 'Mixer stopped during granulation', batch);
  await expect(page.locator('.statusbar')).toContainText('Awaiting classification');
  await logOut(page);

  await logIn(page, 'qa1');
  await classify(page, number);
  await expect(page.locator('.statusbar')).toContainText('Investigation');
  await expect(page.locator('.statusbar')).toContainText('Target date');
  await logOut(page);

  await logIn(page, 'us2');
  await expect(page.getByRole('row', { name: new RegExp(number) })).toContainText('you');
  // DV-11: the search box finds it by batch number, written differently.
  await page.getByLabel('Search').fill(batch.toLowerCase().replace('-', ' '));
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('row', { name: new RegExp(number) })).toBeVisible();
});

test('DV-20: the QA person who reported a deviation cannot classify it', async ({ page }) => {
  await logIn(page, 'qa1');
  await report(page, 'Label roll mix-up found', `LBL-${Date.now().toString(36)}`);
  await expect(page.getByText('You reported this deviation, so another QA person classifies it.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save classification' })).toHaveCount(0);
});

test('overdue deviations are shown in red on the list', async ({ page }) => {
  await logIn(page, 'us1');
  const number = await report(page, 'Late investigation example', `OVD-${Date.now().toString(36)}`);
  await logOut(page);
  await logIn(page, 'qa2');
  await classify(page, number, 'Minor');
  const db = owner();
  await db`update deviations set target_date = current_date - 2 where number = ${number}`;
  await db.end();
  await page.getByRole('button', { name: '← All deviations' }).click();
  await page.getByRole('button', { name: 'Overdue', exact: true }).click();
  await expect(page.getByRole('row', { name: new RegExp(number) }).locator('.chip-bad')).toContainText('Overdue');
});

test('DV-02: a planned deviation shows "do not proceed" until QA signs the approval', async ({ page }) => {
  await logIn(page, 'us1');
  const number = await report(page, 'Use 1.2 mm sieve for one batch', `SV-${Date.now().toString(36)}`, true);
  await logOut(page);
  await logIn(page, 'qa1');
  await classify(page, number, 'Minor');
  await expect(page.locator('.statusbar')).toContainText('Do not proceed before approval');
  await page.getByRole('button', { name: 'Approve planned deviation' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('User ID').fill('qa1');
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign' }).click();
  await expect(page.locator('.statusbar')).toContainText('Investigation');
  await expect(page.locator('.signature')).toContainText('Approved (planned deviation may proceed) · QA1');
});
