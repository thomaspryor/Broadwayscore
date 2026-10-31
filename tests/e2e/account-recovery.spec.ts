import { test, expect } from './helpers/test';
import type { Page } from '@playwright/test';

// Uses the real SDK, AuthProvider, REST helper and toast. Every account API
// request is intercepted; this never creates or deletes a real account.
test.skip(!process.env.RUN_UGC_TESTS, 'Requires the local accounts build');

const user = { id: '00000000-0000-4000-8000-000000004904', email: 'recovery@bsc-test.dev', user_metadata: {} };
const session = {
  access_token: `e30.${Buffer.from(JSON.stringify({ sub: user.id, exp: 4102444800 })).toString('base64url')}.c2ln`,
  refresh_token: 'test-refresh', token_type: 'bearer', expires_at: 4102444800, expires_in: 3600, user,
};

async function mockAccount(page: Page, status = 409) {
  const logouts: string[] = [];
  const writes: unknown[] = [];
  await page.route('**/auth/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/logout')) {
      logouts.push(url.searchParams.get('scope') || 'global');
      await route.fulfill({ status: 204 });
    } else {
      await route.fulfill({ json: user });
    }
  });
  await page.route('**/rest/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/watchlist') && request.method() === 'POST') {
      writes.push(request.postDataJSON());
      await route.fulfill({ status, json: {
        code: status === 409 ? '23503' : 'PGRST301',
        message: status === 409
          ? 'insert or update on table "watchlist" violates foreign key constraint "watchlist_user_id_fkey"'
          : 'JWT expired',
      } });
    } else if (path.endsWith('/profiles')) {
      await route.fulfill({ json: { id: user.id, display_name: 'Recovery test', avatar_url: '/favicon.svg', onboarding_completed_at: '2026-10-01T00:00:00Z' } });
    } else {
      await route.fulfill({ json: [] });
    }
  });
  await page.route('**/functions/v1/**', route => route.fulfill({ json: {} }));
  await page.route('https://formspree.io/**', route => route.abort());
  return { logouts, writes };
}

for (const status of [409, 401]) {
  test(`watchlist ${status} signs out locally and offers recovery`, async ({ page }) => {
    const { logouts, writes } = await mockAccount(page, status);
    await page.addInitScript(value => {
      localStorage.setItem('bsc_auth', JSON.stringify(value));
      localStorage.setItem('bsc_pending_action', JSON.stringify({ type: 'rating', showId: 'hamilton-2015', rating: 4, timestamp: Date.now() }));
    }, session);
    await page.goto('/my-shows?tab=watchlist');
    await page.getByRole('button', { name: 'Add to watchlist', exact: true }).click();
    await page.getByPlaceholder('Search to add...').fill('Hamilton');
    await page.getByRole('button', { name: /Hamilton/ }).first().click();
    await expect(page.getByText('Your account no longer exists on this device; sign in again').first()).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(logouts).toEqual(['local']);
    expect(await page.evaluate(() => localStorage.getItem('bsc_auth'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('bsc_pending_action'))).toBeNull();
    await expect(page.getByRole('button', { name: 'Add to watchlist', exact: true })).toHaveCount(0);
  });
}

for (const path of ['/auth/callback', '/auth/complete']) {
  test(`${path} catches a session stored at the timeout`, async ({ page }) => {
    await mockAccount(page);
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.addInitScript(() => {
      localStorage.setItem('bsc_return_url', '/my-shows?tab=watchlist');
      const original = window.setTimeout;
      window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (ms === 15000) document.documentElement.dataset.callbackWaiting = 'true';
        return original(fn, ms, ...args);
      }) as typeof window.setTimeout;
    });
    await page.goto(path);
    await page.waitForFunction(() => document.documentElement.dataset.callbackWaiting === 'true');
    await page.clock.fastForward(14999);
    await page.evaluate(value => localStorage.setItem('bsc_auth', JSON.stringify(value)), session);
    await page.clock.fastForward(1);
    await page.clock.runFor(200);
    await page.waitForURL(/\/my-shows\?tab=watchlist/, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Sign-in couldn’t finish' })).toHaveCount(0);
  });
}

test('a true callback failure provides a working Retry link and readable mobile layout', async ({ page }) => {
  await mockAccount(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/auth/complete?error=server_error&error_description=raw+internal+details');
  await expect(page.getByRole('heading', { name: 'Sign-in couldn’t finish' })).toBeVisible();
  await expect(page.getByText('raw internal details')).toHaveCount(0);
  const retry = page.getByRole('link', { name: 'Retry', exact: true });
  await expect(retry).toHaveAttribute('href', '/?signin=1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The destination can need a cold compile on the local test server.
  await retry.click({ noWaitAfter: true });
  await expect(page.getByRole('button', { name: /Continue with Google/ })).toBeVisible({ timeout: 30000 });
});
