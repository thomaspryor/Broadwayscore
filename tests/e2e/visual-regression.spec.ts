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
    // TicketButtonsAB renders nothing until PostHog A/B flags load (5s
    // fallback), leaving the header card 6px shorter until the ticket CTA
    // appears. Wait for the CTA so screenshots always capture the settled
    // state. catch() keeps this from failing if the show has no ticket links —
    // note it also masks selector breakage (e.g. CTA copy change), which would
    // silently degrade back to the original flake rather than error here.
    await page
      .locator('[data-testid="show-header-card"]')
      .getByText('Get Tickets')
      .waitFor({ timeout: 8000 })
      .catch(() => {});
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
