import { test, expect } from '@playwright/test';

/**
 * Visual regression tests for UGC (User-Generated Content) components.
 * Uses /test/ugc-fixture (hardcoded mock data) for stable baselines.
 *
 * Runs on daily cron only (not on push). Baselines generated in CI.
 * To update baselines: gh workflow run "Test Suite" -f test_type=visual-only -f update_snapshots=true
 */

const FIXTURE_URL = '/test/ugc-fixture';

test.describe('UGC Visual Regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.waitForSelector('[data-testid="star-ratings-section"]');
  });

  // --- Star Ratings ---

  test('star ratings — empty state', async ({ page }) => {
    const el = page.locator('[data-testid="stars-empty"]');
    await expect(el).toHaveScreenshot('stars-empty.png');
  });

  test('star ratings — 5.0 full', async ({ page }) => {
    const el = page.locator('[data-testid="stars-full-5"]');
    await expect(el).toHaveScreenshot('stars-full-5.png');
  });

  test('star ratings — 3.5 half', async ({ page }) => {
    const el = page.locator('[data-testid="stars-half-3-5"]');
    await expect(el).toHaveScreenshot('stars-half-3-5.png');
  });

  test('star ratings — 1.0 low', async ({ page }) => {
    const el = page.locator('[data-testid="stars-low-1"]');
    await expect(el).toHaveScreenshot('stars-low-1.png');
  });

  test('star ratings — small size', async ({ page }) => {
    const el = page.locator('[data-testid="stars-sm-4"]');
    await expect(el).toHaveScreenshot('stars-sm-4.png');
  });

  // --- Watchlist Button ---

  test('watchlist button — not watchlisted', async ({ page }) => {
    const el = page.locator('[data-testid="watchlist-off"]');
    await expect(el).toHaveScreenshot('watchlist-off.png');
  });

  test('watchlist button — watchlisted', async ({ page }) => {
    const el = page.locator('[data-testid="watchlist-on"]');
    await expect(el).toHaveScreenshot('watchlist-on.png');
  });

  // --- Show Page Rating Section (full layout) ---

  test('show page rating section — full layout', async ({ page }) => {
    const el = page.locator('[data-testid="show-page-rating-section"]');
    await expect(el).toHaveScreenshot('show-page-rating-full.png');
  });

  test('existing rating row — stars + edit + new viewing', async ({ page }) => {
    const el = page.locator('[data-testid="existing-rating-row"]');
    await expect(el).toHaveScreenshot('existing-rating-row.png');
  });

  test('previous viewings list', async ({ page }) => {
    const el = page.locator('[data-testid="previous-viewings"]');
    await expect(el).toHaveScreenshot('previous-viewings.png');
  });

  test('watchlist column with date', async ({ page }) => {
    const el = page.locator('[data-testid="watchlist-column"]');
    await expect(el).toHaveScreenshot('watchlist-column.png');
  });

  // --- Sign-In Modal ---

  test('sign-in modal — rating context', async ({ page }) => {
    await page.locator('[data-testid="open-modal-btn"]').click();
    // Wait for modal animation
    await expect(page.locator('text=Continue with Google')).toBeVisible({ timeout: 3000 });

    // Screenshot the modal panel (not the backdrop)
    const modal = page.locator('[role="dialog"][aria-label="Sign in"] .bg-surface-raised');
    await expect(modal).toHaveScreenshot('sign-in-modal-rating.png');
  });
});
