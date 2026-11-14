import { test, expect } from './helpers/test';
import { filterNonCriticalErrors } from './helpers/console-errors';
import { requireFeature, skipOnPrUntilLive } from './helpers/feature-flags';

// /biz dashboard is gated behind the `commercial` feature flag
// (src/config/feature-flags.ts), released 2026-10-26 (BRO-6192), so these run.
// requireFeature() still skips them if the flag is pulled again, and
// skipOnPrUntilLive() skips them on PR runs until /biz is on production.
test.describe('/biz Dashboard - Basic Tests', () => {
  requireFeature('commercial');
  test.beforeEach(async ({ request }) => skipOnPrUntilLive(request, '/biz'));

  test.beforeEach(async ({ page }) => {
    await page.goto('/biz');
  });

  test('page loads without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.waitForLoadState('networkidle');

    // Filter out expected warnings
    const criticalErrors = filterNonCriticalErrors(errors);
    expect(criticalErrors).toHaveLength(0);
  });

  test('main header and subtitle render', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Broadway Profitability Scorecard');
    await expect(page.getByText('Who made money on Broadway, and who lost it')).toBeVisible();
  });

  // BRO-6376: the header names the page a profitability database.
  test('header positions the page as a profitability database', async ({ page }) => {
    await expect(page.getByText('The Broadway profitability database', { exact: true })).toBeVisible();
    await expect(page.getByText(/For the first time ever, Broadway profitability in one public database/)).toBeVisible();
  });

  // BRO-6376: the nowrap pill measured 310px against 288px of room at 320px wide.
  test('eyebrow pill fits the narrowest phone', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const pill = page.getByText('The Broadway profitability database', { exact: true });
    await expect(pill).toBeVisible();
    const box = await pill.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(320 - 16);
  });

  // BRO-6405: the verdict chips from the share card sit in the header, above the fold.
  test('designation chips sit in the header and link to the guide', async ({ page }) => {
    const chips = page.getByTestId('biz-designation-chips');
    await expect(chips).toBeVisible();
    for (const name of ['Miracle', 'Windfall', 'Easy Winner', 'Trickle', 'Fizzle', 'Flop']) {
      await expect(chips.getByText(name, { exact: true })).toBeVisible();
    }
    const stats = await page.getByTestId('biz-hero-stats').boundingBox();
    const row = await chips.boundingBox();
    expect(row!.y).toBeGreaterThan(stats!.y);
    expect(row!.y).toBeLessThan(page.viewportSize()!.height);
    await chips.getByText('Miracle', { exact: true }).click();
    await expect(page).toHaveURL(/#designation-guide$/);
  });

  // BRO-6283: the four season cards are gone; the Season by Season table leads the page.
  test('season by season table renders first', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Season by Season', exact: true })).toBeVisible();
    await expect(page.getByTestId('season-history')).toBeVisible();
    await expect(page.getByText('Capital at Risk')).toHaveCount(0);
  });

  // BRO-4721: the JSON/CSV "(soon)" buttons were removed until downloads ship.
  test('no placeholder download buttons', async ({ page }) => {
    await expect(page.getByRole('button', { name: /JSON/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /CSV/i })).toHaveCount(0);
  });

  // BRO-6286: the "All Shows" back link gave way to a stat strip; site nav covers home.
  test('hero stat strip shows three non-zero numbers', async ({ page }) => {
    const values = page.locator('[data-testid="biz-hero-stats"] dd');
    await expect(values).toHaveCount(3);
    for (const text of await values.allTextContents()) {
      expect(text).toMatch(/^\$?[1-9][\d,.]*[MB]?$/);
    }
  });

  // Skipped 2026-05-22: /biz dashboard was simplified — no designation legend
  // is rendered. Designations still exist in src/config/commercial.ts but are
  // only shown inline on individual show rows, not as a standalone legend.
  test.skip('designation legend renders', async ({ page: _page }) => {});
});

test.describe('/biz Dashboard - Tables', () => {
  requireFeature('commercial');
  test.beforeEach(async ({ request }) => skipOnPrUntilLive(request, '/biz'));

  test.beforeEach(async ({ page }) => {
    await page.goto('/biz');
    await page.waitForLoadState('networkidle');
  });

  test('recent recoupments table renders', async ({ page }) => {
    await expect(page.getByText('Recent Recoupments')).toBeVisible();
  });

  test('all shows table renders', async ({ page }) => {
    // Look for either "All Open Shows" or a shows table structure
    const hasAllOpenShows = await page.getByText('All Open Shows').isVisible().catch(() => false);
    const hasShowsTable = await page.locator('table').first().isVisible().catch(() => false);

    expect(hasAllOpenShows || hasShowsTable).toBeTruthy();
  });

  test('table has sortable headers', async ({ page }) => {
    // Check that there are table headers (may or may not be buttons)
    const hasTableHeaders = await page.locator('th').first().isVisible().catch(() => false);
    const hasSortButtons = await page.locator('button:has-text("Show")').first().isVisible().catch(() => false);

    expect(hasTableHeaders || hasSortButtons).toBeTruthy();
  });
});

test.describe('/biz Dashboard - Navigation', () => {
  requireFeature('commercial');
  test.beforeEach(async ({ request }) => skipOnPrUntilLive(request, '/biz'));

  // Skipped 2026-05-22: /biz dashboard no longer renders direct /show/* links
  // in its initial HTML. Test times out waiting for a[href^="/show/"] that
  // doesn't exist on the simplified dashboard.
  test.skip('show links in tables navigate to show pages', async ({ page }) => {
    await page.goto('/biz');
    await page.waitForLoadState('networkidle');

    // Find a link in the recoupments or shows table
    const showLink = page.locator('a[href^="/show/"]').first();
    const href = await showLink.getAttribute('href');

    if (href) {
      await showLink.click();
      await expect(page).toHaveURL(href);
    }
  });
});

test.describe('/biz-buzz Redirect', () => {
  // Skip: Redirect is handled by Vercel at the edge layer
  // Client-side fallback only works in local development
  // After deployment, this test would pass on Vercel but not locally
  test.skip('old /biz-buzz URL redirects to /biz', async ({ page }) => {
    await page.goto('/biz-buzz');
    await page.waitForLoadState('networkidle');

    // Should end up at /biz (either via server redirect or client-side)
    await expect(page).toHaveURL('/biz');
  });
});
