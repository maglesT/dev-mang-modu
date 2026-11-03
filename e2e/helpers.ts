import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { E2E_PORT, E2E_SCHEMA } from './config.js';

const baseURL = `http://127.0.0.1:${E2E_PORT}`;

// Owner connection to the e2e schema, only to move time behind the application's back.
export const owner = () => connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });

// Sign-on goes through Medhanta core (D-43); the test server's stand-in signs in whoever login_hint names.
export async function logIn(page: Page, username: string) {
  await page.goto(`/login?login_hint=${encodeURIComponent(username)}`);
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
}

export async function logOut(page: Page) {
  await page.getByRole('button', { name: 'Log out' }).click();
  // The browser goes on to core's sign-out page (here the stand-in's, on the app itself).
  await page.waitForURL(/signed-out=/);
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
}

// Signs in the open SignDialog (PL-05): the click opens the window where core asks for the password again; the test
// server's stand-in confirms the signed-in person at once.
export async function sign(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true }).click();
}

// A signing proof through the API, as the sign window gets it.
export async function proofOf(ctx: APIRequestContext, meaning: string): Promise<string> {
  const html = await (await ctx.get(`/sign?meanings=${meaning}`)).text();
  const proof = /"signProof":"([^"]+)"/.exec(html)?.[1];
  expect(proof, html).toBeTruthy();
  return proof!;
}

// Set-up that is not the point of a test goes through the API, as the given user.
export async function apiAs(username: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.get(`/login?login_hint=${encodeURIComponent(username)}`);
  expect(res.ok()).toBe(true);
  expect((await ctx.get('/api/me')).ok()).toBe(true);
  return ctx;
}

export async function post(ctx: APIRequestContext, url: string, data: object) {
  const res = await ctx.post(url, { data });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return res.json();
}
