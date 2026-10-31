import { test, expect } from './helpers/test';
import { type Page } from '@playwright/test';
import { assertNoHorizontalOverflow } from './helpers/layout-assertions';

/**
 * Signed-out /my-shows lists the shows saved on this device, above the
 * sign-in pitch (BRO-4903 item b). Seeds the device list the way
 * useLocalWatchlist stores it (localStorage `bsc_local_watchlist`, see
 * src/lib/local-watchlist.ts) with real ids from /data/show-lookup.json plus
 * one id no show has, so it holds against any data day.
 *
 * Signed out needs no auth setup, so this runs in the main E2E job.
 * Run locally: TEST_BASE_URL=http://localhost:3114 npx playwright test --project=chromium tests/e2e/my-shows-signed-out-device.spec.ts
 */

const LIST_KEY = 'bsc_local_watchlist';

interface LookupRow { id: string; t: string; st?: string; cd?: string; c?: string }

async function pickShows(page: Page): Promise<{ open: LookupRow[]; closed: LookupRow }> {
  const res = await page.request.get('/data/show-lookup.json');
  expect(res.ok()).toBeTruthy();
  const rows = (await res.json()) as LookupRow[];
  const open = rows.filter(r => r.st === 'open' && !r.cd).slice(0, 2);
  const closed = rows.find(r => !r.st);
  expect(open.length).toBe(2);
  expect(closed).toBeTruthy();
  return { open, closed: closed! };
}

async function seed(page: Page, entries: { showId: string; savedAt: number }[] | null) {
  await page.addInitScript(([key, value]) => {
    try {
      if (value === null) window.localStorage.removeItem(key as string);
      else window.localStorage.setItem(key as string, value as string);
    } catch { /* storage blocked: the page falls back to nothing saved */ }
  }, [LIST_KEY, entries ? JSON.stringify(entries) : null]);
}

test.describe('My Shows signed out: shows saved on this device (390px)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('lists saved shows (open first, unknown id skipped) above the sign-in pitch', async ({ page }) => {
    const { open, closed } = await pickShows(page);
    const now = Date.now();
    await seed(page, [
      { showId: closed.id, savedAt: now },
      { showId: 'no-such-show-bro-4903', savedAt: now - 1 },
      { showId: open[0].id, savedAt: now - 2 },
      { showId: open[1].id, savedAt: now - 3 },
    ]);
    await page.goto('/my-shows');

    const section = page.getByTestId('device-saved-shows');
    await expect(section).toBeVisible({ timeout: 30000 });
    await expect(section.getByRole('heading', { name: /saved on this device/i })).toBeVisible();
    await expect(section).toContainText('3 shows');

    const cards = section.getByRole('link');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toHaveAttribute('aria-label', `View ${open[0].t}`);
    await expect(cards.nth(1)).toHaveAttribute('aria-label', `View ${open[1].t}`);
    await expect(cards.nth(2)).toHaveAttribute('aria-label', `View ${closed.t}`);
    await expect(cards.nth(2)).toContainText(/closed/i);
    await expect(section).not.toContainText('no-such-show-bro-4903');

    // The sign-in pitch still sits underneath.
    const google = page.getByRole('button', { name: 'Continue with Google' });
    await expect(google).toBeVisible();
    const sectionBox = await section.boundingBox();
    const googleBox = await google.boundingBox();
    expect(sectionBox && googleBox && googleBox.y > sectionBox.y + sectionBox.height - 1).toBeTruthy();

    await assertNoHorizontalOverflow(page);
  });

  test('nothing saved on this device keeps the plain sign-in view', async ({ page }) => {
    await seed(page, null);
    await page.goto('/my-shows');
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('device-saved-shows')).toHaveCount(0);
  });

  test('only unknown ids saved keeps the plain sign-in view', async ({ page }) => {
    await seed(page, [{ showId: 'no-such-show-bro-4903', savedAt: Date.now() }]);
    await page.goto('/my-shows');
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible({ timeout: 30000 });
    // Let the lookup load before asserting absence.
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('device-saved-shows')).toHaveCount(0);
  });
});
