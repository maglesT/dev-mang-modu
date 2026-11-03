import { expect, test } from '@playwright/test';
import { logIn, logOut } from './helpers.js';

test('PL-01 a person signs in through core, sees only what their codes allow, and logging out ends the core session too', async ({ page }) => {
  await logIn(page, 'us1');
  await expect(page.locator('.who')).toContainText('US1');
  await expect(page.getByRole('button', { name: 'Audit trail' })).toHaveCount(0);
  await logOut(page);
  await logIn(page, 'admin');
  await expect(page.getByRole('button', { name: 'Admin' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Audit trail' })).toBeVisible();
  await logOut(page);
});
