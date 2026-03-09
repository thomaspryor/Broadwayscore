import { test, expect } from '@playwright/test';

/**
 * Visual regression tests for layout-critical UI regions.
 * Uses /show/hamilton-2015 (stable, long-running show) for consistent baselines.
 *
 * To update baselines: gh workflow run "Test Suite" -f test_type=visual-only -f update_snapshots=true
 */

const SHOW_URL = '/show/hamilton';

test.describe('Visual Regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(SHOW_URL);
    await page.waitForSelector('[data-testid="show-header-card"]');
  });

  test('show header card layout', async ({ page }) => {
    const header = page.locator('[data-testid="show-header-card"]');
    await expect(header).toHaveScreenshot('show-header-card.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('meta line wrapping', async ({ page }) => {
    const metaLine = page.locator('[data-testid="show-meta-line"]');
    await expect(metaLine).toHaveScreenshot('show-meta-line.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('review card alignment', async ({ page }) => {
    const reviewCard = page.locator('[data-testid="review-card"]').first();
    await expect(reviewCard).toHaveScreenshot('review-card.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});
