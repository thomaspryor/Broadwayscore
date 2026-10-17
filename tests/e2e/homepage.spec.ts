import { test, expect } from '@playwright/test';
import { filterNonCriticalErrors } from './helpers/console-errors';

test.describe('Homepage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('loads successfully without errors', async ({ page }) => {
    // Check page title
    await expect(page).toHaveTitle(/Broadway/i);

    // Check for console errors
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Wait for page to be fully loaded
    await page.waitForLoadState('networkidle');

    // Filter out known non-critical errors
    const criticalErrors = filterNonCriticalErrors(errors);

    expect(criticalErrors).toHaveLength(0);
  });

  test('displays show cards', async ({ page }) => {
    // The homepage paints in two passes:
    //   1. src/app/page.tsx server-renders the "Best Recent Shows" shelf above
    //      the fold (FeaturedRowServer) so the LCP image is in the initial HTML.
    //   2. HomePageClient hydrates and renders the main grid — the element with
    //      role="list" / aria-label="Broadway shows" — showing every currently
    //      playing show, INITIAL_SHOW_COUNT (20) at a time.
    //
    // The old assertion counted every show link on the page immediately after
    // the FIRST one became visible, so on a fast machine it measured pass 2 and
    // on a slow one it measured pass 1. That was invisible for as long as pass 1
    // alone satisfied it: the server shelf is slice(0, 10) of the Broadway
    // musicals/plays that opened in the last 12 months and are still running,
    // and there were >= 10 of those until 2026-07-26. Broadway's late-summer
    // closings took it to 9 on 07-27, 8 on 08-09 and 6 on 08-10 (25 of the 31
    // shows that opened since 2025-08-14 have already closed) — 6 is the honest
    // number for that shelf, and it dips to 5 when Ragtime closes 2026-08-16
    // before the new season refills it. From that point a bare count() was a
    // coin flip on hydration: 26 unthrottled, 6 with the CPU throttled 4x.
    //
    // So: wait for the grid rather than racing it, and hang the floor on the
    // grid, which is what "the homepage is working" actually means. 10 sits far
    // below the ~20 the grid renders and above the 6 the server shelf can supply
    // on its own, so a hydration failure or an empty grid still fails the test
    // while a thin Broadway week does not.
    const showCards = page.locator('[data-testid="show-card"], article, .show-card, a[href^="/show/"]');
    await expect(showCards.first()).toBeVisible({ timeout: 10000 });

    const grid = page.getByRole('list', { name: 'Broadway shows' });
    await expect(grid).toBeVisible({ timeout: 15000 });

    const gridCards = grid.locator('a[href^="/show/"]');
    await expect
      .poll(() => gridCards.count(), { timeout: 15000 })
      .toBeGreaterThanOrEqual(10);

    // Page-wide floor kept as a backstop: the grid plus the server shelf.
    expect(await showCards.count()).toBeGreaterThanOrEqual(10);
  });

  test('show cards have required elements', async ({ page }) => {
    // Find show cards/links
    const showLinks = page.locator('a[href^="/show/"]').first();
    await expect(showLinks).toBeVisible({ timeout: 10000 });

    // First show card should have a title
    const firstCard = page.locator('a[href^="/show/"]').first();
    await expect(firstCard).toBeVisible();

    // Should have text content (show title)
    const text = await firstCard.textContent();
    expect(text?.length).toBeGreaterThan(0);
  });

  test('navigation menu is accessible', async ({ page }) => {
    // Check for main navigation elements
    const nav = page.locator('nav, header');
    await expect(nav.first()).toBeVisible();
  });

  test('filters are functional', async ({ page }) => {
    // Look for filter buttons or tabs
    const filters = page.locator('button, [role="tab"], .filter');

    // Should have some filter options
    const filterCount = await filters.count();
    expect(filterCount).toBeGreaterThan(0);
  });

  test('clicking a show card navigates to show page', async ({ page }) => {
    // Wait for show cards
    const showLink = page.locator('a[href^="/show/"]').first();
    await expect(showLink).toBeVisible({ timeout: 10000 });

    // Get the href before clicking
    const href = await showLink.getAttribute('href');
    expect(href).toBeTruthy();

    // Click the show card
    await showLink.click();

    // Should navigate to show page
    await expect(page).toHaveURL(new RegExp(`/show/`));
  });

  test('page is responsive on mobile', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    // Page should still load
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Show cards should still be visible
    const showLinks = page.locator('a[href^="/show/"]').first();
    await expect(showLinks).toBeVisible({ timeout: 10000 });
  });
});
