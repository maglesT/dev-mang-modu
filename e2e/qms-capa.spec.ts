import { expect, test } from '@playwright/test';
import { apiAs, post, proofOf } from './helpers.js';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { TOOLS } from '../test/fixtures.js';
import { E2E_QMS_PORT, E2E_SCHEMA, QMS_URL } from './config.js';

// D-63: with the QMS linked, the deviation page and the CAPA list show the QMS's CAPAs read-only, and "Raise CAPA in QMS"
// opens the QMS new-CAPA screen with the deviation number. Set-up through the API of the app without the QMS (same data).
test('DV-08: QMS linked: the deviation shows its QMS CAPAs read-only and raises a CAPA in QMS with the deviation number', async ({ page }) => {
  const us1 = await apiAs('us1');
  const areas = await (await us1.get('/api/areas')).json();
  const { id, number } = await post(us1, '/api/deviations', {
    planned: false, title: 'Granule moisture high', description: 'LOD above limit after drying.', areaId: areas[0].id,
    eventAt: new Date(Date.now() - 600_000).toISOString(), products: [{ product: 'Example tablets 10 mg', batch: `EXQ-${Date.now().toString(36)}` }],
    initialImpact: { productQuality: 'unknown', patientSafety: 'no', otherBatches: 'no', notes: 'Being assessed.' }, immediateAction: 'Batch on hold.',
  });
  await us1.dispose();
  const qa = await apiAs('qa1');
  const types = await (await qa.get('/api/deviation-types')).json();
  const people = await (await qa.get('/api/people')).json();
  await post(qa, `/api/deviations/${id}/classify`, { classification: 'major', typeId: types[0].id, impact: 'This batch.',
    investigatorId: people.find((p: { username: string }) => p.username === 'us2').id, productBatchChecked: true });
  await qa.dispose();
  const us2 = await apiAs('us2');
  await post(us2, `/api/deviations/${id}/investigate`, {
    data: { ...TOOLS, rootCause: 'Dryer probe drift.', otherBatches: [], noOtherReason: 'Only this batch dried.', conclusion: 'Re-dry.' },
    signature: { proof: await proofOf(us2, 'investigation_complete') },
  });
  await us2.dispose();
  // The QMS has raised one CAPA for it (as the QMS publishes it).
  const o = connect(TEST_DATABASE_URL, {}, 1);
  await o.unsafe(`insert into ${E2E_SCHEMA}_qms.capa_v1 (capa_number, title, status, status_text, source_kind, source_ref, owner_name, due_date)
    values ('QCAPA-26-E01', 'Recalibrate the dryer probe', 'in_progress', 'Implementation', 'deviation', $1, 'Example Owner', current_date + 20)`, [number]);
  await o.end();

  const base = `http://127.0.0.1:${E2E_QMS_PORT}`;
  await page.goto(`${base}/login?login_hint=qa1`);
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await page.getByRole('button', { name: number }).click();
  await expect(page.getByText('QCAPA-26-E01')).toBeVisible();
  await expect(page.getByText('from QMS').first()).toBeVisible();
  await expect(page.getByText('Implementation')).toBeVisible();
  const raise = page.getByRole('link', { name: 'Raise CAPA in QMS' });
  await expect(raise).toHaveAttribute('href', `${QMS_URL}/capa/new?source=deviation&ref=${number}`);
  await expect(page.getByRole('button', { name: 'Raise a CAPA' })).toHaveCount(0);

  await page.getByRole('button', { name: 'CAPAs' }).first().click();
  await expect(page.getByRole('heading', { name: 'CAPAs in QMS' })).toBeVisible();
  await expect(page.getByText('QCAPA-26-E01')).toBeVisible();
  await expect(page.getByText('New CAPA (audit, complaint, other)')).toHaveCount(0);
});
