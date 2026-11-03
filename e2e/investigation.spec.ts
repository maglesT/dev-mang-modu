import { expect, test, type Page } from '@playwright/test';
import { apiAs, logIn, post, sign } from './helpers.js';

// A deviation reported by us1 and classified by qa1 with us2 as investigator, set up through the API.
async function inInvestigation(batch: string) {
  const us1 = await apiAs('us1');
  const areas = await (await us1.get('/api/areas')).json();
  const { id, number } = await post(us1, '/api/deviations', {
    planned: false, title: 'Tablet weight out of limit', description: 'IPC weight 520 mg vs 500 ± 5%.', areaId: areas[0].id,
    eventAt: new Date(Date.now() - 600_000).toISOString(), products: [{ product: 'Paracetamol 500 mg', batch }], initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'unknown', notes: 'Being assessed.' }, immediateAction: 'Machine stopped.',
  });
  await us1.dispose();
  const qa = await apiAs('qa1');
  const types = await (await qa.get('/api/deviation-types')).json();
  const people = await (await qa.get('/api/people')).json();
  await post(qa, `/api/deviations/${id}/classify`, {
    classification: 'major', typeId: types[0].id, impact: 'This batch only.', investigatorId: people.find((p: { username: string }) => p.username === 'us2').id, productBatchChecked: true,
  });
  await qa.dispose();
  return number as string;
}

// S13: fills every tool through the screen (Is / Is Not, 6M with evidence, 5 Whys, category).
async function fillTools(page: Page) {
  for (const q of ['What', 'Where', 'When', 'Who', 'Extent']) {
    await page.getByLabel(`${q}: is`, { exact: true }).fill(`${q} is`);
    await page.getByLabel(`${q}: is not`, { exact: true }).fill(`${q} is not`);
    await page.getByLabel(`${q}: what it tells`).fill('Narrows it down');
  }
  for (const m of ['People', 'Machine / equipment', 'Method', 'Material', 'Measurement', 'Environment']) {
    await page.getByLabel(`${m}: what was checked`).fill(m === 'Machine / equipment' ? 'Feeder speed changed during maintenance.' : `${m} checked`);
    await page.getByLabel(`${m}: evidence`).fill('Record reviewed');
    await page.getByRole('radiogroup', { name: `${m}: verdict` }).getByLabel(m === 'Machine / equipment' ? 'Ruled in' : 'Ruled out').check();
  }
  await page.getByLabel('5 Whys: problem statement').fill('Tablet weight high');
  for (const i of [1, 2, 3]) {
    await page.getByLabel(`Why ${i}: answer`).fill(`Because ${i}`);
    await page.getByLabel(`Why ${i}: evidence`).fill(`Evidence ${i}`);
  }
  await page.getByLabel('Root-cause category *').selectOption({ label: 'Equipment' });
  // S14: barrier analysis and FMEA.
  await page.getByLabel('Barrier 1', { exact: true }).fill('Supervisor check');
  await page.getByLabel('Barrier 1: did it work').selectOption('no');
  await page.getByLabel('Barrier 1: why it failed').fill('Supervisor not present');
  await page.getByLabel('FMEA: Severity').selectOption('6');
  await page.getByLabel('FMEA: Occurrence').selectOption('4');
  await page.getByLabel('FMEA: Detection').selectOption('5');
  await expect(page.getByText('Risk priority number: 120')).toBeVisible();
  await page.getByLabel('FMEA: risk to the patient').fill('Soft tablets could break.');
}

test('DV-04 to DV-07: the investigator writes the root cause, checks other batches and signs', async ({ page }) => {
  const number = await inInvestigation(`WT-${Date.now().toString(36)}`);
  await logIn(page, 'us2');
  await page.getByRole('button', { name: number }).click();
  // S13: signing first lists what is missing; a draft keeps the work.
  await page.getByRole('button', { name: 'Sign investigation complete' }).click();
  await expect(page.getByRole('alert')).toContainText('Is / Is Not, what: is: required.');
  await page.getByLabel('Root cause *').fill('Feeder speed changed after maintenance; not reset.');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status')).toContainText('Draft 1 saved');
  await fillTools(page);
  await page.getByRole('button', { name: 'Add a batch checked' }).click();
  await page.getByLabel('Other product 1').fill('Paracetamol 500 mg');
  await page.getByLabel('Other batch 1').fill('PCM-OLD-1');
  await page.getByLabel('Conclusion *').fill('Only this batch affected; tablets since last good IPC rejected.');
  await page.getByRole('button', { name: 'Sign investigation complete' }).click();
  await sign(page);
  await expect(page.locator('.statusbar')).toContainText('Awaiting closure');
  await expect(page.locator('.signature')).toContainText('Investigation complete · US2');
  await expect(page.getByText('PCM-OLD-1: not affected')).toBeVisible();
  // The signed investigation shows the 6M fishbone with the ruled-in cause under its category.
  await expect(page.getByRole('group', { name: 'Fishbone diagram' })).toContainText('Feeder speed changed during maintenance.');
  await expect(page.getByRole('group', { name: 'Fishbone diagram' })).toContainText('Ruled in');
  // S11: the DMAIC view moves on: Define, Measure and Analyze are done; Improve (CAPAs) is next.
  const dmaic = page.getByRole('list', { name: 'DMAIC progress' });
  await expect(dmaic).toContainText('Analyze · done');
  await expect(dmaic).toContainText('Improve · in progress');
});

test('DV-05: ticking human error asks for a justification before signing', async ({ page }) => {
  const number = await inInvestigation(`HE-${Date.now().toString(36)}`);
  await logIn(page, 'us2');
  await page.getByRole('button', { name: number }).click();
  await page.getByLabel('The cause is human error').check();
  await expect(page.getByLabel(/^Why human error/)).toBeVisible();
});

test('DV-14: a correction needs a reason and keeps the earlier version readable', async ({ page }) => {
  const number = await inInvestigation(`CR-${Date.now().toString(36)}`);
  await logIn(page, 'us1');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('button', { name: number }).click();
  await page.locator('section').filter({ has: page.getByRole('heading', { name: 'Report', exact: true }) }).getByRole('button', { name: 'Correct' }).click();
  await page.getByLabel('Title *').fill('Tablet weight above upper limit');
  await page.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByText('Give the reason for the correction.')).toBeVisible();
  await page.getByLabel('Reason for the correction *').fill('Title more precise');
  await page.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Tablet weight above upper limit');
  await page.getByText(/Corrected · version 2 by US1/).click();
  await expect(page.locator('.old-version')).toContainText('Tablet weight out of limit');
});

test('DV-21: a file is attached and listed; withdrawing keeps it listed with the reason', async ({ page }) => {
  const number = await inInvestigation(`AT-${Date.now().toString(36)}`);
  await logIn(page, 'us1');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('button', { name: number }).click();
  await page.getByLabel(/^Attach a file/).setInputFiles({ name: 'ipc-printout.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 IPC') });
  await expect(page.getByRole('link', { name: 'ipc-printout.pdf' })).toBeVisible();
  page.once('dialog', (d) => void d.accept('Wrong printout'));
  await page.getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.getByText('withdrawn: Wrong printout')).toBeVisible();
});

test('S8: a deviation naming a batch from another deviation shows the hint, with a link to it', async ({ page }) => {
  const batch = `RP-${Date.now().toString(36)}`;
  const first = await inInvestigation(batch);
  const second = await inInvestigation(batch);
  await logIn(page, 'us2');
  await page.getByRole('button', { name: second }).click();
  const hints = page.getByRole('region', { name: 'Things to look at' });
  await expect(hints).toContainText('This batch is also named in 1 other deviation');
  await hints.getByRole('button', { name: first }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(first);
});

test('S9: the investigator asks the AI, reads simple suggestions and adds one to the fishbone', async ({ page }) => {
  const number = await inInvestigation(`AI-${Date.now().toString(36)}`);
  // The AI service is replaced in the browser, so the test never calls Google.
  await page.route('**/api/ai/status', (r) => r.fulfill({ json: { enabled: true, model: 'gemini-test' } }));
  await page.route('**/api/deviations/*/ai-suggest', (r) => r.fulfill({ json: {
    model: 'gemini-test', summary: 'Tablets were too heavy. Start with the press settings.',
    causes: [{ category: 'machine', cause: 'Feeder speed changed', why: 'It started after maintenance.', howToCheck: 'Read the maintenance log.' }],
    questions: ['Who changed the setting?'], otherBatches: 'Batches made on the same press since maintenance.',
  } }));
  await logIn(page, 'us2');
  await page.getByRole('button', { name: number }).click();
  const help = page.getByRole('region', { name: 'AI help' });
  await help.getByRole('button', { name: 'Ask AI for possible causes' }).click();
  await expect(help).toContainText('How to check: Read the maintenance log.');
  await expect(help).toContainText('you check and decide');
  await help.getByRole('button', { name: 'Add to fishbone' }).click();
  await expect(page.getByLabel('Machine / equipment: what was checked')).toHaveValue('Feeder speed changed');
});

test('DV-23: the Measure band fetches related data; a system that is not connected says so', async ({ page }) => {
  const number = await inInvestigation(`DC-${Date.now().toString(36)}`);
  await logIn(page, 'us2');
  await page.getByRole('button', { name: number }).click();
  const card = page.getByRole('region', { name: 'Data collection' });
  await card.getByRole('button', { name: 'Fetch related data' }).click();
  await expect(card).toContainText('Batch record (Batchwright)');
  await expect(card).toContainText('Not connected on this installation.');
  await expect(card.getByRole('button', { name: 'Fetch again' })).toBeVisible();
});
