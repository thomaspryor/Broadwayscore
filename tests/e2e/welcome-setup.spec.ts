import { test, expect } from './helpers/test';
import { type Locator, type Page, type Route } from '@playwright/test';

/**
 * BRO-6917 Part 4: the optional two-screen welcome setup, run as a REAL
 * signed-in new account against a mocked Supabase.
 *
 * `?welcome=preview` exercises the screens with no account and writes nothing,
 * so it cannot catch a wrong insert payload, a duplicate-handling bug or a
 * missing toast. Here the page holds a stored session (bsc_auth), every
 * Supabase request is answered by an in-memory backend, and the assertions read
 * what the sheet actually wrote.
 *
 * Needs a build with NEXT_PUBLIC_SUPABASE_URL/ANON_KEY and the userAccounts
 * flag; without them the sheet cannot open and the tests skip. Listed in
 * playwright.config.ts testIgnore (like the other UGC specs), so the main CI run
 * against production never sees it. Run locally against a dev server with:
 *   RUN_UGC_TESTS=1 TEST_BASE_URL=http://localhost:3111 npx playwright test tests/e2e/welcome-setup.spec.ts --project=chromium
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

const NOW = Math.floor(Date.now() / 1000);
const ACCESS_TOKEN = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
  sub: USER_ID, aud: 'authenticated', role: 'authenticated', exp: NOW + 86400, iat: NOW,
  email: 'welcome-test@example.com',
})}.sig`;

const AUTH_USER = {
  id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'welcome-test@example.com',
  app_metadata: { provider: 'email' }, user_metadata: { full_name: 'Welcome Tester', avatar_url: 'https://example.com/a.png' },
  created_at: new Date().toISOString(),
};

interface Backend {
  /** table -> rows */
  tables: Record<string, Record<string, unknown>[]>;
  /** Every non-GET request, in order, for payload assertions. */
  writes: { method: string; table: string; body: unknown; query: string }[];
  claims: number;
  /** Next N inserts into this table fail with a 500. */
  failNext: Record<string, number>;
  /** table -> show ids a GET pretends are absent (a row another tab wrote after the sheet looked). */
  hideFromGet?: Record<string, string[]>;
}

function newBackend(): Backend {
  return {
    tables: {
      profiles: [{
        id: USER_ID, display_name: 'Welcome Tester', avatar_url: 'https://example.com/a.png',
        created_at: new Date().toISOString(), onboarding_seen_at: null,
      }],
      reviews: [], watchlist: [], seen_unrated: [],
    },
    writes: [], claims: 0, failNext: {},
  };
}

function matchesFilter(row: Record<string, unknown>, params: URLSearchParams): boolean {
  for (const [key, value] of params.entries()) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue;
    if (value.startsWith('eq.')) {
      if (String(row[key]) !== value.slice(3)) return false;
    } else if (value.startsWith('in.(')) {
      const ids = value.slice(4, -1).split(',').map(s => s.replace(/^"|"$/g, ''));
      if (!ids.includes(String(row[key]))) return false;
    }
  }
  return true;
}

async function installBackend(page: Page, be: Backend) {
  const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
    route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

  await page.route(`${SUPABASE_URL}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const cors = { 'access-control-allow-origin': '*' };

    if (url.pathname.startsWith('/auth/v1/user')) return json(route, 200, AUTH_USER, cors);
    if (url.pathname.startsWith('/auth/v1/token')) {
      return json(route, 200, { access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 86400, refresh_token: 'r', user: AUTH_USER }, cors);
    }
    if (url.pathname.startsWith('/auth/v1/')) return json(route, 200, {}, cors);

    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(.+)$/);
    if (rpc) {
      if (rpc[1] === 'claim_onboarding') {
        const profile = be.tables.profiles[0];
        const first = profile.onboarding_seen_at === null;
        if (first) { profile.onboarding_seen_at = new Date().toISOString(); be.claims++; }
        return json(route, 200, first, cors);
      }
      return json(route, 200, null, cors);
    }

    const m = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m) return json(route, 200, [], cors);
    const table = m[1];
    const rows = (be.tables[table] ||= []);
    const body = (() => { try { return req.postDataJSON(); } catch { return null; } })();
    const singleObject = (req.headers()['accept'] || '').includes('vnd.pgrst.object');

    if (method === 'GET' || method === 'HEAD') {
      const hidden = be.hideFromGet?.[table] || [];
      const found = rows.filter(r => matchesFilter(r, url.searchParams) && !hidden.includes(String(r.show_id)));
      if (singleObject) return found.length ? json(route, 200, found[0], cors) : json(route, 406, { code: 'PGRST116', message: 'no rows' }, cors);
      return json(route, 200, found, cors);
    }

    be.writes.push({ method, table, body, query: url.search });

    if (method === 'POST') {
      if ((be.failNext[table] || 0) > 0) {
        be.failNext[table]--;
        return json(route, 500, { code: 'XX000', message: 'simulated failure' }, cors);
      }
      const incoming = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
      const uniqueByShow = table === 'watchlist' || table === 'seen_unrated';
      for (const row of incoming) {
        if (uniqueByShow && rows.some(r => r.user_id === row.user_id && r.show_id === row.show_id)) {
          return json(route, 409, { code: '23505', message: 'duplicate key value violates unique constraint' }, cors);
        }
      }
      rows.push(...incoming);
      return json(route, 201, incoming, cors);
    }
    if (method === 'DELETE') {
      const keep = rows.filter(r => !matchesFilter(r, url.searchParams));
      be.tables[table] = keep;
      return json(route, 200, [], cors);
    }
    if (method === 'PATCH') {
      rows.filter(r => matchesFilter(r, url.searchParams)).forEach(r => Object.assign(r, body));
      return json(route, 200, [], cors);
    }
    return json(route, 200, [], cors);
  });
}

async function signInAs(page: Page) {
  await page.addInitScript(({ token, user }) => {
    try {
      localStorage.setItem('bsc_auth', JSON.stringify({
        access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 86400,
        expires_at: Math.floor(Date.now() / 1000) + 86400, user,
      }));
    } catch { /* storage blocked */ }
    // Record analytics: a stand-in PostHog that keeps every capture() call, so the test reads exactly what the sheet sent.
    // The real posthog-js loads in dev and assigns window.posthog, so the property ignores reassignment.
    const events: { e: string; p: Record<string, unknown> }[] = [];
    const stub = { capture: (e: string, p: Record<string, unknown>) => { events.push({ e, p: p || {} }); } };
    (window as unknown as { __phEvents: typeof events }).__phEvents = events;
    Object.defineProperty(window, 'posthog', { get: () => stub, set: () => { /* keep the stand-in */ }, configurable: true });
  }, { token: ACCESS_TOKEN, user: AUTH_USER });
}

/** The analytics the sheet sent, as recorded by the stand-in PostHog from signInAs. */
async function sentEvents(page: Page): Promise<{ e: string; p: Record<string, unknown> }[]> {
  return page.evaluate(() => (window as unknown as { __phEvents?: { e: string; p: Record<string, unknown> }[] }).__phEvents ?? []);
}

/** Poster buttons on the first screen. Each carries its show's title in its aria-label. */
function seenPosters(sheet: Locator) {
  return sheet.locator('[data-testid="welcome-grid"] li button:not([disabled])');
}

/** show title -> show id for the Broadway lists (seen posters and want posters), as the sheet loads them on "/". Titles repeat across markets (two Lion Kings), so only one market is mapped. */
async function idsByTitle(page: Page): Promise<Map<string, string>> {
  const res = await page.request.get('/welcome-shows.json');
  type Entry = { id: string; title: string };
  const d = await res.json() as { shows?: Entry[]; markets?: { broadway?: Entry[] }; wants?: { broadway?: Entry[] } };
  const all = [...(d.markets?.broadway ?? d.shows ?? []), ...(d.wants?.broadway ?? [])];
  return new Map(all.map(s => [s.title, s.id]));
}

async function titleOf(button: Locator): Promise<string> {
  const label = (await button.getAttribute('aria-label')) || '';
  return label.split(',')[0];
}

async function openSheet(page: Page) {
  await page.goto('/');
  const sheet = page.getByTestId('welcome-sheet');
  await sheet.waitFor({ state: 'visible', timeout: 30_000 });
  return sheet;
}

const SKIP_REASON = 'needs NEXT_PUBLIC_SUPABASE_URL/ANON_KEY in the test environment';

test.describe('Welcome setup (signed-in new account, mocked Supabase)', () => {
  test.skip(!SUPABASE_URL, SKIP_REASON);

  test('seen picks with and without stars, then wants, are saved, summarised and tracked', async ({ page }) => {
    const be = newBackend();
    await installBackend(page, be);
    await signInAs(page);
    const sheet = await openSheet(page);
    const ids = await idsByTitle(page);

    await expect(sheet).toHaveAttribute('data-step', 'shows');
    await expect(sheet.getByRole('heading', { name: 'Which have you seen?' })).toBeVisible();

    // Two picks: the first gets 4 stars, the second stays "seen it".
    const posters = seenPosters(sheet);
    await expect(posters.nth(1)).toBeVisible({ timeout: 20_000 });
    const firstTitle = await titleOf(posters.nth(0));
    const secondTitle = await titleOf(posters.nth(1));
    const firstId = ids.get(firstTitle);
    const secondId = ids.get(secondTitle);
    expect(firstId && secondId && firstId !== secondId, 'both picks resolve to distinct show ids').toBeTruthy();

    await posters.nth(0).click();
    // A click on the right half of a star is the whole star (the left half is a half star).
    const fourth = sheet.getByTestId('welcome-rate-row').getByRole('button', { name: '4 stars' });
    const box = await fourth.boundingBox();
    await fourth.click({ position: { x: Math.round(box!.width * 0.8), y: Math.round(box!.height / 2) } });
    await posters.nth(1).click();
    await expect(sheet.getByText('2 picked')).toBeVisible();

    await sheet.getByTestId('welcome-next').click();
    await expect(sheet).toHaveAttribute('data-step', 'want');

    // The starred pick is a reviews row, the plain one a seen_unrated row, both owned by this user.
    const reviewWrite = be.writes.find(w => w.table === 'reviews' && w.method === 'POST');
    const unratedWrite = be.writes.find(w => w.table === 'seen_unrated' && w.method === 'POST');
    expect(reviewWrite, 'a reviews insert for the starred pick').toBeTruthy();
    expect(unratedWrite, 'a seen_unrated insert for the unstarred pick').toBeTruthy();
    expect(reviewWrite!.body).toMatchObject({ user_id: USER_ID, show_id: firstId, rating: 4 });
    expect(unratedWrite!.body).toMatchObject({ user_id: USER_ID, show_id: secondId });

    // Shows just saved are not offered again as "want to see".
    const wantGrid = sheet.getByTestId('welcome-want-grid');
    await expect(wantGrid).toBeVisible();
    const offeredTitles = await wantGrid.locator('li button').evaluateAll(els => els.map(e => (e.getAttribute('aria-label') || '').split(',')[0]));
    expect(offeredTitles.length).toBeGreaterThan(2);
    expect(offeredTitles).not.toContain(firstTitle);
    expect(offeredTitles).not.toContain(secondTitle);
    const wantIds = [ids.get(offeredTitles[0]), ids.get(offeredTitles[1])];

    // Bookmark two, finish.
    await wantGrid.locator('li button').nth(0).click();
    await wantGrid.locator('li button').nth(1).click();
    await expect(sheet.getByText('2 saved')).toBeVisible();
    await sheet.getByTestId('welcome-done').click();

    await expect(sheet).toBeHidden();
    const watchWrites = be.writes.filter(w => w.table === 'watchlist' && w.method === 'POST');
    expect(watchWrites.map(w => (w.body as Record<string, unknown>).show_id).sort()).toEqual([...wantIds].sort());
    expect(watchWrites.every(w => (w.body as Record<string, unknown>).user_id === USER_ID)).toBe(true);
    expect(be.claims, 'claim_onboarding spent exactly once').toBe(1);

    const toast = page.getByText(/Saved to your account: 2 seen, 2 to see\./);
    await expect(toast).toBeVisible();
    await expect(page.getByText(/Add stars any time under To Be Rated\./)).toBeVisible();

    const events = await sentEvents(page);
    const names = events.map(x => x.e);
    expect(names).toEqual(expect.arrayContaining(['onboarding_shown', 'onboarding_step_completed', 'onboarding_completed']));
    const seenStep = events.find(x => x.e === 'onboarding_step_completed' && x.p.step === 'shows');
    expect(seenStep?.p).toMatchObject({ shows_added: 2, rated: 1 });
    const wantStep = events.find(x => x.e === 'onboarding_step_completed' && x.p.step === 'want');
    expect(wantStep?.p).toMatchObject({ want_added: 2 });
    expect(events.find(x => x.e === 'onboarding_completed')?.p).toMatchObject({ shows_added: 2, want_added: 2 });
  });

  test('Skip on both screens writes nothing and shows no toast', async ({ page }) => {
    const be = newBackend();
    await installBackend(page, be);
    await signInAs(page);
    const sheet = await openSheet(page);

    await expect(sheet.getByTestId('welcome-next')).toHaveText(/Skip/);
    await sheet.getByTestId('welcome-next').click();
    await expect(sheet).toHaveAttribute('data-step', 'want');
    await expect(sheet.getByTestId('welcome-done')).toHaveText(/Skip/);
    await sheet.getByTestId('welcome-done').click();
    await expect(sheet).toBeHidden();

    expect(be.writes).toEqual([]);
    expect(be.claims).toBe(1);
    await expect(page.getByText(/Saved to your account/)).toHaveCount(0);
  });

  test('closing on the first screen with picks still saves them', async ({ page }) => {
    const be = newBackend();
    await installBackend(page, be);
    await signInAs(page);
    const sheet = await openSheet(page);
    const ids = await idsByTitle(page);

    const posters = seenPosters(sheet);
    await expect(posters.first()).toBeVisible({ timeout: 20_000 });
    const title = await titleOf(posters.first());
    await posters.first().click();
    await page.keyboard.press('Escape');

    await expect(sheet).toBeHidden();
    const saved = be.writes.find(w => w.table === 'seen_unrated' && w.method === 'POST');
    expect(saved?.body).toMatchObject({ user_id: USER_ID, show_id: ids.get(title) });
    await expect(page.getByText(/Saved to your account: 1 seen\./)).toBeVisible();
  });

  test('a duplicate (saved from another tab) counts as saved, not as a failure', async ({ page }) => {
    const be = newBackend();
    await installBackend(page, be);
    await signInAs(page);
    const sheet = await openSheet(page);
    const ids = await idsByTitle(page);

    const posters = seenPosters(sheet);
    await expect(posters.first()).toBeVisible({ timeout: 20_000 });
    const id = ids.get(await titleOf(posters.first()));
    await posters.first().click();
    // Another tab saved it after the sheet looked, so the sheet's insert hits the unique key.
    be.tables.seen_unrated.push({ user_id: USER_ID, show_id: id });
    be.hideFromGet = { seen_unrated: [String(id)] };
    await sheet.getByTestId('welcome-next').click();

    await expect(sheet).toHaveAttribute('data-step', 'want');
    await expect(sheet.getByText(/could not save/i)).toHaveCount(0);
    expect(be.tables.seen_unrated.length, 'no second row').toBe(1);
  });

  test('a failed save keeps the sheet open with an error, and the retry succeeds', async ({ page }) => {
    const be = newBackend();
    be.failNext.seen_unrated = 1;
    await installBackend(page, be);
    await signInAs(page);
    const sheet = await openSheet(page);

    const posters = seenPosters(sheet);
    await expect(posters.first()).toBeVisible({ timeout: 20_000 });
    await posters.first().click();
    await sheet.getByTestId('welcome-next').click();

    await expect(sheet).toHaveAttribute('data-step', 'shows');
    await expect(sheet.getByText(/could not save/i)).toBeVisible();

    await sheet.getByTestId('welcome-next').click();
    await expect(sheet).toHaveAttribute('data-step', 'want');
    expect(be.tables.seen_unrated.length).toBe(1);
  });

  test('a partly failed save is shown, keeps only the failed pick, and the counts add up after the retry', async ({ page }) => {
    const be = newBackend();
    be.failNext.seen_unrated = 1; // the first of two inserts fails, the second goes through
    await installBackend(page, be);
    await signInAs(page);
    const sheet = await openSheet(page);

    const posters = seenPosters(sheet);
    await expect(posters.nth(1)).toBeVisible({ timeout: 20_000 });
    await posters.nth(0).click();
    await posters.nth(1).click();
    await sheet.getByTestId('welcome-next').click();

    // One saved, one not: the sheet says so and stays on this screen instead of moving on quietly.
    await expect(sheet.getByText(/could not save/i)).toBeVisible();
    await expect(sheet).toHaveAttribute('data-step', 'shows');
    expect(be.tables.seen_unrated.length).toBe(1);
    await expect(sheet.getByText('1 picked')).toBeVisible();

    await sheet.getByTestId('welcome-next').click();
    await expect(sheet).toHaveAttribute('data-step', 'want');
    expect(be.tables.seen_unrated.length).toBe(2);

    await sheet.getByTestId('welcome-done').click();
    await expect(sheet).toBeHidden();
    // Both picks count, not just the retry's.
    await expect(page.getByText(/Saved to your account: 2 seen\./)).toBeVisible();
  });

  test('a failed close-time save does not make the second screen throw its bookmarks away', async ({ page }) => {
    const be = newBackend();
    be.failNext.seen_unrated = 1;
    await installBackend(page, be);
    await signInAs(page);
    const sheet = await openSheet(page);

    const posters = seenPosters(sheet);
    await expect(posters.first()).toBeVisible({ timeout: 20_000 });
    await posters.first().click();
    await page.keyboard.press('Escape');
    await expect(sheet.getByText(/could not save/i)).toBeVisible();
    await expect(sheet).toBeVisible();

    // Retry through Next, then close on the second screen with a bookmark picked.
    await sheet.getByTestId('welcome-next').click();
    await expect(sheet).toHaveAttribute('data-step', 'want');
    await sheet.getByTestId('welcome-want-grid').locator('li button').first().click();
    await page.keyboard.press('Escape');

    await expect(sheet).toBeHidden();
    expect(be.writes.filter(w => w.table === 'watchlist' && w.method === 'POST').length, 'the bookmark was saved on close').toBe(1);
    await expect(page.getByText(/Saved to your account: 1 seen, 1 to see\./)).toBeVisible();
  });

  test('a sign-up that started mid-task (rating or bookmark) gets no sheet, and the claim is spent quietly', async ({ page }) => {
    const be = newBackend();
    await installBackend(page, be);
    await signInAs(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('bsc_signin_midflow', JSON.stringify({ context: 'rating', ts: Date.now() })); } catch { /* storage blocked */ }
    });
    await page.goto('/');
    await expect.poll(() => be.claims, { timeout: 20_000 }).toBe(1);
    await page.waitForTimeout(2500);
    await expect(page.getByTestId('welcome-sheet')).toHaveCount(0);
  });

  test('an account past the first-day window never gets the sheet', async ({ page }) => {
    const be = newBackend();
    be.tables.profiles[0].created_at = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await installBackend(page, be);
    await signInAs(page);
    await page.goto('/');
    await page.waitForTimeout(6000);
    await expect(page.getByTestId('welcome-sheet')).toHaveCount(0);
    expect(be.claims).toBe(0);
  });

  test('phone width: the sheet fills the screen and scrolls inside', async ({ page }) => {
    const be = newBackend();
    await installBackend(page, be);
    await signInAs(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const sheet = await openSheet(page);
    await expect(seenPosters(sheet).first()).toBeVisible({ timeout: 20_000 });
    const box = await sheet.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(388);
    expect(box!.height).toBeGreaterThanOrEqual(840);
    // No sideways page scroll behind it.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('desktop width: a right-hand panel, not a full-screen takeover', async ({ page }) => {
    const be = newBackend();
    await installBackend(page, be);
    await signInAs(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const sheet = await openSheet(page);
    await expect(seenPosters(sheet).first()).toBeVisible({ timeout: 20_000 });
    const box = await sheet.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(470);
    expect(box!.x + box!.width).toBeGreaterThanOrEqual(1430);
    expect(box!.height).toBeGreaterThanOrEqual(890);
  });
});
