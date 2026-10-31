import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { PASSWORD, TEST_DATABASE_URL } from '../test/helpers.js';
import { E2E_PORT, E2E_SCHEMA } from './config.js';

export { PASSWORD };
const baseURL = `http://127.0.0.1:${E2E_PORT}`;

// Owner connection to the e2e schema, only to move time behind the application's back.
export const owner = () => connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });

export async function logIn(page: Page, username: string, password = PASSWORD) {
  await page.goto('/');
  await page.getByLabel('User ID').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

export async function logOut(page: Page) {
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
}

// Set-up that is not the point of a test goes through the API, as the given user.
export async function apiAs(username: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post('/api/login', { data: { username, password: PASSWORD } });
  expect(res.ok()).toBe(true);
  return ctx;
}

export async function post(ctx: APIRequestContext, url: string, data: object) {
  const res = await ctx.post(url, { data });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return res.json();
}
