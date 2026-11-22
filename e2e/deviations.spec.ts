import { expect, test, type Page } from '@playwright/test';
import { logIn, logOut, owner, sign } from './helpers.js';

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

// D-57: the batch is picked from the linked TrueBatch products; its product comes with it. A typed batch is marked.
test('D-57: a reporter picks the batch from the list (product filled), and a batch not in the list is saved as typed by hand', async ({ page }) => {
  await logIn(page, 'us1');
  await page.getByRole('button', { name: 'Report a deviation' }).click();
  await page.getByLabel('Title *').fill('Vial crimp loose');
  await page.getByLabel('What happened *').fill('Three vials found with loose crimps at inspection.');
  await page.getByLabel('Area *').selectOption({ label: 'Packing' });
  await expect(page.getByText('Pick the batch from the list; its product comes with it.')).toBeVisible();
  await page.getByLabel('Batch 1').fill('TI26E01');
  await expect(page.getByLabel('Product 1')).toHaveValue('FG-INJ-EX25');
  await expect(page.getByLabel('Product 1')).not.toBeEditable();
  await page.getByRole('button', { name: 'Add another batch' }).click();
  await page.getByLabel('Batch 2').fill('PAPER-9');
  await page.getByLabel('Product 2').fill('Saline 500 mL');
  await expect(page.getByText('Typed by hand', { exact: true })).toHaveCount(1);
  await page.getByRole('radiogroup', { name: 'Could product quality be affected?' }).getByLabel('Not known yet').check();
  await page.getByRole('radiogroup', { name: 'Could patient safety be at risk?' }).getByLabel('No', { exact: true }).check();
  await page.getByRole('radiogroup', { name: 'Could other batches be affected?' }).getByLabel('No', { exact: true }).check();
  await page.getByLabel('Short assessment *').fill('Vials segregated.');
  await page.getByLabel('Action taken (immediate action) *').fill('Line stopped, crimper checked.');
  await page.getByRole('button', { name: 'Save and get a number' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Vial crimp loose');
  await expect(page.getByText('FG-INJ-EX25 / TI26E01; Saline 500 mL / PAPER-9 (typed by hand)')).toBeVisible();
});

// D-59: a batch of a new TrueBatch product (Capsules Packing on the test server) is picked the same way.
test('D-59: a batch of TrueBatch Capsules Packing is picked from the list, its product filled', async ({ page }) => {
  await logIn(page, 'us1');
  await page.getByRole('button', { name: 'Report a deviation' }).click();
  await page.getByLabel('Title *').fill('Blister seal weak');
  await page.getByLabel('What happened *').fill('Weak seals on two blister strips at the seal check.');
  await page.getByLabel('Area *').selectOption({ label: 'Packing' });
  await page.getByLabel('Batch 1').fill('CP26E01');
  await expect(page.getByLabel('Product 1')).toHaveValue('PK-CAP-EX20-B10');
  await expect(page.getByLabel('Product 1')).not.toBeEditable();
  await expect(page.getByText('Typed by hand', { exact: true })).toHaveCount(0);
  await page.getByRole('radiogroup', { name: 'Could product quality be affected?' }).getByLabel('Not known yet').check();
  await page.getByRole('radiogroup', { name: 'Could patient safety be at risk?' }).getByLabel('No', { exact: true }).check();
  await page.getByRole('radiogroup', { name: 'Could other batches be affected?' }).getByLabel('No', { exact: true }).check();
  await page.getByLabel('Short assessment *').fill('Strips segregated.');
  await page.getByLabel('Action taken (immediate action) *').fill('Sealing temperature checked.');
  await page.getByRole('button', { name: 'Save and get a number' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Blister seal weak');
  await expect(page.getByText('PK-CAP-EX20-B10 / CP26E01')).toBeVisible();
});

// D-60: QA files the phase II investigation of a LIMS OOS by picking it; the OOS cannot be picked a second time.
test('D-60: QA picks an OOS from QLIMS: its details fill the report, the record keeps the OOS, and it is not offered again', async ({ page }) => {
  await logIn(page, 'qa1');
  await page.getByRole('button', { name: 'Report a deviation' }).click();
  const pick = page.getByLabel('OOS from QLIMS (phase II investigation)');
  // The OOS still in phase I is listed but cannot be picked.
  await expect(pick.locator('option', { hasText: 'OOS26E002' })).toHaveJSProperty('disabled', true);
  await pick.selectOption({ label: 'OOS26E001: Assay of FG-EX-10 Example tablets 10 mg (invented), lot EX26E01; result 91.2 %, limit 95.0 to 105.0 %' });
  await expect(page.getByLabel('Title *')).toHaveValue('OOS26E001 phase II: Assay of FG-EX-10 Example tablets 10 mg (invented), lot EX26E01');
  await expect(page.getByLabel('What happened *')).toHaveValue(/result 91\.2 %, limit 95\.0 to 105\.0 %\. Phase I found no laboratory error/);
  await expect(page.getByLabel('Batch 1')).toHaveValue('EX26E01');
  await expect(page.getByLabel('Batch 1')).not.toBeEditable();
  await expect(page.getByLabel('Product 1')).toHaveValue('FG-EX-10');
  await expect(page.getByText('From QLIMS OOS', { exact: true })).toBeVisible();
  // D-61: an OOS is a QC laboratory deviation: the area is set, not chosen; the long OOS list stays inside the form card.
  await expect(page.getByLabel('Area *')).toHaveValue('QC laboratory (QLIMS)');
  await expect(page.getByLabel('Area *')).not.toBeEditable();
  await page.setViewportSize({ width: 760, height: 900 });
  const [selectBox, cardBox] = [await pick.boundingBox(), await page.locator('form.card').boundingBox()];
  expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
  await page.getByRole('radiogroup', { name: 'Could product quality be affected?' }).getByLabel('Yes', { exact: true }).check();
  await page.getByRole('radiogroup', { name: 'Could patient safety be at risk?' }).getByLabel('Not known yet').check();
  await page.getByRole('radiogroup', { name: 'Could other batches be affected?' }).getByLabel('Not known yet').check();
  await page.getByLabel('Short assessment *').fill('Lot on hold until phase II is concluded.');
  await page.getByLabel('Action taken (immediate action) *').fill('Lot EX26E01 kept on hold in QC.');
  await page.getByRole('button', { name: 'Save and get a number' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('OOS26E001 phase II');
  const number = (await page.getByRole('heading', { level: 1 }).textContent())!.split(' · ')[0]!;
  await expect(page.getByText('OOS26E001: Assay of FG-EX-10 Example tablets 10 mg (invented), lot EX26E01; result 91.2 %, limit 95.0 to 105.0 %')).toBeVisible();
  await expect(page.getByText('FG-EX-10 / EX26E01', { exact: true })).toBeVisible();
  await expect(page.getByText('QC laboratory (QLIMS)', { exact: true })).toBeVisible();
  // Back on the form, the OOS shows the deviation it already has and cannot be picked again.
  await page.getByRole('button', { name: '← All deviations' }).click();
  await page.getByRole('button', { name: 'Report a deviation' }).click();
  await expect(page.getByLabel('OOS from QLIMS (phase II investigation)').locator('option', { hasText: `already has ${number}` })).toHaveJSProperty('disabled', true);
});

// D-58: a batch picked from TrueBatch was checked there: QA classifies without the tick, and the record says so.
test('D-58: a picked batch needs no "checked product and batch" tick at classification', async ({ page }) => {
  await logIn(page, 'us1');
  await page.getByRole('button', { name: 'Report a deviation' }).click();
  await page.getByLabel('Title *').fill('Stopper bowl jam');
  await page.getByLabel('What happened *').fill('Stopper bowl jammed for 5 minutes.');
  await page.getByLabel('Area *').selectOption({ label: 'Packing' });
  await page.getByLabel('Batch 1').fill('TI26E01');
  await expect(page.getByLabel('Product 1')).toHaveValue('FG-INJ-EX25');
  await page.getByRole('radiogroup', { name: 'Could product quality be affected?' }).getByLabel('Not known yet').check();
  await page.getByRole('radiogroup', { name: 'Could patient safety be at risk?' }).getByLabel('No', { exact: true }).check();
  await page.getByRole('radiogroup', { name: 'Could other batches be affected?' }).getByLabel('No', { exact: true }).check();
  await page.getByLabel('Short assessment *').fill('Vials in the jam segregated.');
  await page.getByLabel('Action taken (immediate action) *').fill('Bowl cleared.');
  await page.getByRole('button', { name: 'Save and get a number' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Stopper bowl jam');
  const number = (await page.getByRole('heading', { level: 1 }).textContent())!.split(' · ')[0]!;
  await logOut(page);

  await logIn(page, 'qa1');
  await page.getByRole('button', { name: number }).click();
  await expect(page.getByText('Product and batch: picked from the batch record, checked automatically.')).toBeVisible();
  await expect(page.getByLabel('I checked the product and batch numbers against the batch record')).toHaveCount(0);
  await page.getByLabel('Minor').check();
  await page.getByLabel('Type').selectOption({ label: 'Process' });
  await page.getByLabel('Investigator').selectOption({ label: 'US2 (us2)' });
  await page.getByLabel(/^Impact assessment/).fill('This batch only.');
  await page.getByRole('button', { name: 'Save classification' }).click();
  await expect(page.getByText('Picked from the batch record (checked automatically)')).toBeVisible();
});

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
  await sign(page);
  await expect(page.locator('.statusbar')).toContainText('Investigation');
  await expect(page.locator('.signature')).toContainText('Approved (planned deviation may proceed) · QA1');
});

// D-66: a CPV signal QA sent in Operations is filed once as a deviation: QA sees it with its product, batch (pulled) and rule.
test('D-66: a CPV signal sent from Operations is a deviation in the Operations CPV area, its batch pulled', async ({ page }) => {
  await logIn(page, 'qa1');
  const row = page.getByRole('row', { name: /Continued process verification: Tablet hardness, batch EX26E05/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Operations CPV (automatic)');
  await row.getByRole('button').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Continued process verification: Tablet hardness, batch EX26E05');
  await expect(page.getByText('FG-EX-10 / EX26E05', { exact: true })).toBeVisible();
  await expect(page.getByText(/out of trend, Nelson rule 1\./).first()).toBeVisible();
  await expect(page.getByText(/CPV\) signal 3 in Operations: product Example tablets 10 mg \(invented\) \(FG-EX-10\), batch EX26E05, parameter Tablet hardness/)).toBeVisible();
  await expect(page.getByText('Operations CPV (automatic report)').first()).toBeVisible();
});

// D-67: QA cancels a report as "not a deviation" with a reason and one e-signature; the record stays, under its own filter.
test('D-67: QA cancels a report as not a deviation: reason, one signature, kept and listed under "Not a deviation"', async ({ page }) => {
  await logIn(page, 'us1');
  const number = await report(page, 'Weight check thought missed', `NAD-${Date.now().toString(36)}`);
  // The reporter holds no cancel right: no button.
  await expect(page.getByRole('button', { name: 'Not a deviation (cancel)' })).toHaveCount(0);
  await logOut(page);

  await logIn(page, 'qa1');
  await page.getByRole('button', { name: number }).click();
  await page.getByRole('button', { name: 'Not a deviation (cancel)' }).click();
  await expect(page.getByRole('dialog')).toContainText('Sign: Cancelled: not a deviation');
  await page.getByLabel('Reason why this is not a deviation').fill('The check was on the paper log at 10:00; it was copied late.');
  await sign(page);
  await expect(page.locator('.statusbar')).toContainText('Cancelled by QA: not a deviation');
  const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Cancelled by QA: not a deviation' }) });
  await expect(card).toContainText('copied late');
  await expect(card).toContainText('QA1');
  await expect(page.getByRole('button', { name: 'Not a deviation (cancel)' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Investigation' })).toHaveCount(0);
  // Display round 20 Nov 2026: the history in words, times as "20 Nov, 21:21 IST" on screens (this year: no year; no raw keys, no am/pm).
  const history = page.locator('section.card', { has: page.getByRole('heading', { name: 'History' }) });
  await expect(history).toContainText('Signed: Cancelled: not a deviation');
  await expect(history).not.toContainText('signed.');
  await expect(history.locator('td').first()).toHaveText(/^\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2} IST$/);

  await page.getByRole('button', { name: '← All deviations' }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('row', { name: new RegExp(number) })).toHaveCount(0);
  await page.getByRole('button', { name: 'Not a deviation', exact: true }).click();
  await expect(page.getByRole('row', { name: new RegExp(number) })).toContainText('Cancelled by QA: not a deviation');
});
