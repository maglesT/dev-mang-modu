import { expect, test } from '@playwright/test';

test('the app loads and shows its name', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Deviations & CAPA' })).toBeVisible();
});
