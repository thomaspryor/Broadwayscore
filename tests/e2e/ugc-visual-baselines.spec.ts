import { test, expect } from '@playwright/test';
import { VIEWPORTS, goToMock, goToShowFixture } from './helpers/mock-helpers';

/**
 * Visual baseline screenshots for all UGC states.
 * Catches visual regressions (trash icon centering, star sizing, overflow, etc.)
 *
 * Run: TEST_BASE_URL=http://localhost:3456 npx playwright test --project=chromium tests/e2e/ugc-visual-baselines.spec.ts
 * Update baselines: add --update-snapshots
 */

for (const vp of VIEWPORTS) {
  test.describe(`UGC Visual Baselines — ${vp.name} (${vp.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
    });

    // ─── My Shows — Diary ──────────────────────────────────────

    test('diary grid view (default)', async ({ page }) => {
      await goToMock(page, 'diary');
      await expect(page.locator('#main-content')).toHaveScreenshot(`diary-grid-${vp.width}.png`, {
        animations: 'disabled',
      });
    });

    test('diary list view', async ({ page }) => {
      await goToMock(page, 'diary');
      await page.getByRole('button', { name: 'List view' }).click();
      await expect(page.getByRole('button', { name: 'List view' })).toHaveClass(/bg-white/, { timeout: 3000 });
      await expect(page.locator('#main-content')).toHaveScreenshot(`diary-list-${vp.width}.png`, {
        animations: 'disabled',
      });
    });

    // ─── My Shows — Watchlist ──────────────────────────────────

    test('watchlist grid view', async ({ page }) => {
      await goToMock(page, 'watchlist');
      await expect(page.locator('#main-content')).toHaveScreenshot(`watchlist-grid-${vp.width}.png`, {
        animations: 'disabled',
      });
    });

    test('watchlist list view', async ({ page }) => {
      await goToMock(page, 'watchlist');
      await page.getByRole('button', { name: 'List view' }).click();
      await expect(page.getByRole('button', { name: 'List view' })).toHaveClass(/bg-white/, { timeout: 3000 });
      await expect(page.locator('#main-content')).toHaveScreenshot(`watchlist-list-${vp.width}.png`, {
        animations: 'disabled',
      });
    });

    // ─── Show Rating Fixture ───────────────────────────────────

    test('rating — existing state', async ({ page }) => {
      await goToShowFixture(page, 'existing');
      await expect(page.locator('#main-content')).toHaveScreenshot(`rating-existing-${vp.width}.png`, {
        animations: 'disabled',
      });
    });

    test('rating — empty state', async ({ page }) => {
      await goToShowFixture(page, 'empty');
      await expect(page.locator('#main-content')).toHaveScreenshot(`rating-empty-${vp.width}.png`, {
        animations: 'disabled',
      });
    });

    test('rating — multi state', async ({ page }) => {
      await goToShowFixture(page, 'multi');
      await expect(page.locator('#main-content')).toHaveScreenshot(`rating-multi-${vp.width}.png`, {
        animations: 'disabled',
      });
    });

    test('rating — review panel open', async ({ page }) => {
      await goToShowFixture(page, 'existing');
      await page.getByRole('button', { name: 'Edit rating' }).click();
      await expect(page.locator('textarea')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('#main-content')).toHaveScreenshot(`rating-panel-open-${vp.width}.png`, {
        animations: 'disabled',
      });
    });

    // ─── Half-Star Rendering (catches SVG clipPath regressions) ──
    test('half-star rendering at all sizes', async ({ page }) => {
      await goToShowFixture(page, 'existing');
      const showcase = page.locator('[data-testid="star-showcase"]');
      await expect(showcase).toBeVisible({ timeout: 5000 });
      await expect(showcase).toHaveScreenshot(`half-star-showcase-${vp.width}.png`, {
        animations: 'disabled',
      });
    });
  });
}
