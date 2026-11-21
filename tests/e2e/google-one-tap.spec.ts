import { test, expect } from './helpers/test';
import { type Page, type Route } from '@playwright/test';

/**
 * BRO-6917 Part 5: Google One Tap on desktop, against a stub of Google's
 * script and a mocked Supabase. The real card is drawn by Google (or Chrome,
 * through FedCM) and cannot be driven from a test; what this proves is OUR half:
 * who is asked, when, what is sent to Supabase, and what happens after.
 *
 * Needs a build with NEXT_PUBLIC_SUPABASE_URL/ANON_KEY and the userAccounts
 * flag. Listed in playwright.config.ts testIgnore (like the other UGC specs).
 * Run locally against a dev or production build with:
 *   RUN_UGC_TESTS=1 TEST_BASE_URL=http://localhost:3111 npx playwright test tests/e2e/google-one-tap.spec.ts --project=chromium
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FAKE_CREDENTIAL = 'fake.google.credential';
const SHOW_PAGE = '/show/hamilton';
/** One Tap waits 8 s after load (ONE_TAP_DELAY_MS); allow for a slow dev compile on top. */
const WAIT_FOR_CARD = 40_000;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
const NOW = Math.floor(Date.now() / 1000);
const ACCESS_TOKEN = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
  sub: USER_ID, aud: 'authenticated', role: 'authenticated', exp: NOW + 86400, iat: NOW, email: 'onetap@example.com',
})}.sig`;
const AUTH_USER = {
  id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'onetap@example.com',
  app_metadata: { provider: 'google' }, user_metadata: { full_name: 'One Tap Tester' },
  created_at: new Date().toISOString(),
};

/** A stand-in for https://accounts.google.com/gsi/client that records what we ask of it. */
const GSI_STUB = `
window.__gsi = { inits: 0, prompts: 0, cancelled: 0, clientId: null, autoSelect: null, tapOutside: null, ctx: null, cb: null, listener: null };
window.google = { accounts: { id: {
  initialize: function (cfg) { var g = window.__gsi; g.inits++; g.clientId = cfg.client_id; g.autoSelect = cfg.auto_select; g.tapOutside = cfg.cancel_on_tap_outside; g.ctx = cfg.context; g.cb = cfg.callback; },
  prompt: function (l) { window.__gsi.prompts++; window.__gsi.listener = l || null; },
  cancel: function () { window.__gsi.cancelled++; }
} } };
`;

interface Harness {
  gsiRequests: number;
  tokenBodies: Array<Record<string, unknown>>;
  /** Make the next id_token exchange fail. */
  failToken: boolean;
}

async function install(page: Page): Promise<Harness> {
  const h: Harness = { gsiRequests: 0, tokenBodies: [], failToken: false };
  await page.route('https://accounts.google.com/gsi/client', (route: Route) => {
    h.gsiRequests++;
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: GSI_STUB });
  });
  const cors = { 'access-control-allow-origin': '*' };
  await page.route(`${SUPABASE_URL}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    }
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    if (url.pathname.startsWith('/auth/v1/token')) {
      if (url.searchParams.get('grant_type') === 'id_token') {
        try { h.tokenBodies.push(req.postDataJSON()); } catch { /* not JSON */ }
        if (h.failToken) return json(400, { error: 'invalid_grant', error_description: 'Bad ID token', code: 'bad_jwt' });
        return json(200, { access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 86400, refresh_token: 'r', user: AUTH_USER });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (url.pathname.startsWith('/auth/v1/user')) return json(200, AUTH_USER);
    if (url.pathname.startsWith('/auth/v1/')) return json(200, {});
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(.+)$/);
    if (rpc) return json(200, rpc[1] === 'claim_onboarding' ? false : null);
    if (url.pathname.startsWith('/rest/v1/profiles')) {
      return json(200, [{ id: USER_ID, display_name: 'One Tap Tester', avatar_url: null, created_at: new Date().toISOString(), onboarding_seen_at: new Date().toISOString() }]);
    }
    return json(200, []);
  });
  return h;
}

const gsi = (page: Page) => page.evaluate(() => {
  const g = (window as unknown as { __gsi?: Record<string, unknown> }).__gsi;
  return g ? { inits: g.inits, prompts: g.prompts, cancelled: g.cancelled, clientId: g.clientId, autoSelect: g.autoSelect, tapOutside: g.tapOutside, ctx: g.ctx } : null;
});

async function waitForCard(page: Page) {
  await page.waitForFunction(() => ((window as unknown as { __gsi?: { prompts: number } }).__gsi?.prompts ?? 0) > 0, null, { timeout: WAIT_FOR_CARD });
}

/** Drives the notification Google sends back to prompt(listener). */
const notify = (page: Page, shape: 'shown' | 'user_cancel' | 'unregistered_origin') => page.evaluate((s) => {
  const l = (window as unknown as { __gsi: { listener: ((n: unknown) => void) | null } }).__gsi.listener;
  if (!l) throw new Error('prompt() was never given a listener');
  if (s === 'shown') l({ isDisplayed: () => true });
  if (s === 'user_cancel') l({ isSkippedMoment: () => true, getSkippedReason: () => 'user_cancel' });
  if (s === 'unregistered_origin') l({ isNotDisplayed: () => true, getNotDisplayedReason: () => 'unregistered_origin' });
}, shape);

const pickCredential = (page: Page) => page.evaluate((cred) => {
  (window as unknown as { __gsi: { cb: (r: { credential: string }) => void } }).__gsi.cb({ credential: cred });
}, FAKE_CREDENTIAL);

test.describe('Google One Tap (desktop, stubbed Google, mocked Supabase)', () => {
  test.skip(!SUPABASE_URL, 'needs NEXT_PUBLIC_SUPABASE_URL/ANON_KEY in the test environment');
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a signed-out desktop visitor is asked once, quietly, with the web client id', async ({ page }) => {
    const h = await install(page);
    await page.goto(SHOW_PAGE);
    // Nothing yet: the card waits out first paint, and Google's script is not even fetched.
    expect(await gsi(page)).toBeNull();
    expect(h.gsiRequests).toBe(0);

    await waitForCard(page);
    const g = await gsi(page);
    expect(g).toMatchObject({ inits: 1, prompts: 1, autoSelect: false, tapOutside: false, ctx: 'signin' });
    expect(String(g!.clientId)).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(h.gsiRequests).toBe(1);
    // No full-screen sign-in box, and no dialog of ours.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Moving to another page in the same visit does not ask again: a full page
    // load wipes the stub, so the proof is that Google's script is not fetched a
    // second time (the session flag holds) and the new page never prompts.
    await page.goto('/');
    await page.waitForTimeout(11_000);
    expect(h.gsiRequests).toBe(1);
    expect(await gsi(page)).toBeNull();
  });

  test('picking the card signs in with the Google credential and stays on the page', async ({ page }) => {
    const h = await install(page);
    await page.goto(SHOW_PAGE);
    await waitForCard(page);
    const before = page.url();

    await pickCredential(page);
    await expect.poll(() => h.tokenBodies.length, { timeout: 15_000 }).toBe(1);
    expect(h.tokenBodies[0]).toMatchObject({ provider: 'google', id_token: FAKE_CREDENTIAL });

    // Signed in, same page, no redirect, no box in the way.
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0, { timeout: 15_000 });
    expect(page.url()).toBe(before);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('a rejected credential opens the normal sign-in box with a plain message', async ({ page }) => {
    const h = await install(page);
    h.failToken = true;
    await page.goto(SHOW_PAGE);
    await waitForCard(page);

    await pickCredential(page);
    const box = page.getByRole('dialog');
    await expect(box).toBeVisible({ timeout: 15_000 });
    await expect(box).toContainText('Google sign-in could not finish');
    // Still signed out, and the other ways in are right there.
    await expect(box.getByRole('button', { name: /google/i }).first()).toBeVisible();
  });

  test('closing the card keeps it quiet for 14 days, even in a new session', async ({ page }) => {
    const h = await install(page);
    await page.goto(SHOW_PAGE);
    await waitForCard(page);
    await notify(page, 'user_cancel');

    const stamp = await page.evaluate(() => localStorage.getItem('bsc_onetap_dismissed'));
    expect(Number(stamp)).toBeGreaterThan(Date.now() - 60_000);

    // A new browser session (sessionStorage gone) is still inside the cooldown.
    await page.evaluate(() => sessionStorage.clear());
    const requestsBefore = h.gsiRequests;
    await page.reload();
    await page.waitForTimeout(11_000);
    expect(h.gsiRequests).toBe(requestsBefore);
    expect(await gsi(page)).toBeNull();
  });

  test('opening the normal sign-in box withdraws the card', async ({ page }) => {
    await install(page);
    await page.goto(SHOW_PAGE);
    await waitForCard(page);

    await page.getByRole('button', { name: 'Sign in' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect.poll(async () => (await gsi(page))?.cancelled ?? 0, { timeout: 5_000 }).toBeGreaterThan(0);
  });

  test('a refused origin leaves the page untouched and does not start the cooldown', async ({ page }) => {
    await install(page);
    await page.goto(SHOW_PAGE);
    await waitForCard(page);
    await notify(page, 'unregistered_origin');

    expect(await page.evaluate(() => localStorage.getItem('bsc_onetap_dismissed'))).toBeNull();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
  });

  test('the OAuth return page is never asked', async ({ page }) => {
    const h = await install(page);
    await page.goto('/auth/complete');
    await page.waitForTimeout(11_000);
    expect(h.gsiRequests).toBe(0);
  });

  test('a visitor who already has a saved session is never asked', async ({ page }) => {
    const h = await install(page);
    await page.addInitScript(([token, user]) => {
      try {
        localStorage.setItem('bsc_auth', JSON.stringify({
          access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 86400,
          expires_at: Math.floor(Date.now() / 1000) + 86400, user,
        }));
      } catch { /* storage blocked */ }
    }, [ACCESS_TOKEN, AUTH_USER] as const);
    await page.goto(SHOW_PAGE);
    await page.waitForTimeout(11_000);
    expect(h.gsiRequests).toBe(0);
  });
});

test.describe('Google One Tap on a phone', () => {
  test.skip(!SUPABASE_URL, 'needs NEXT_PUBLIC_SUPABASE_URL/ANON_KEY in the test environment');
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a phone never loads Google or shows a card', async ({ page }) => {
    const h = await install(page);
    await page.goto(SHOW_PAGE);
    await page.waitForTimeout(11_000);
    expect(h.gsiRequests).toBe(0);
    expect(await gsi(page)).toBeNull();
  });
});
