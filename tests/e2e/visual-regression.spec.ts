import { test, expect } from '@playwright/test';

/**
 * Visual regression tests for layout-critical UI regions.
 * Uses /test/visual-fixture (hardcoded mock data) for stable baselines.
 *
 * Runs on daily cron only (not on push). Baselines generated in CI.
 * To update baselines: gh workflow run "Test Suite" -f test_type=visual-only -f update_snapshots=true
 */

const FIXTURE_URL = '/test/visual-fixture';

test.describe('Visual Regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.waitForSelector('[data-testid="show-header-card"]');
  });

  test('show header card layout', async ({ page }) => {
    const header = page.locator('[data-testid="show-header-card"]');
    await expect(header).toHaveScreenshot('show-header-card.png');
  });

  test('meta line wrapping', async ({ page }) => {
    const metaLine = page.locator('[data-testid="show-meta-line"]');
    await expect(metaLine).toHaveScreenshot('show-meta-line.png');
  });

  test('review card alignment', async ({ page }) => {
    const reviewCard = page.locator('[data-testid="review-card"]').first();
    await expect(reviewCard).toHaveScreenshot('review-card.png');
  });
});
