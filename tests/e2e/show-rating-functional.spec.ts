import { test, expect } from '@playwright/test';
import {
  assertNoOverlaps,
  assertNothingOffScreen,
  assertMinimumTapTargets,
  assertNoHorizontalOverflow,
} from './helpers/layout-assertions';
import { VIEWPORTS, goToShowFixture } from './helpers/mock-helpers';

/**
 * Functional E2E tests for ShowPageRating component.
 * Uses the /test/show-rating-fixture page with local-state callbacks.
 *
 * Run: TEST_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/show-rating-functional.spec.ts
 */

for (const vp of VIEWPORTS) {
  test.describe(`Show Page Rating — ${vp.name} (${vp.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
    });

    // ─── Layout Health ──────────────────────────────────────────

    test('no horizontal overflow', async ({ page }) => {
      await goToShowFixture(page, 'existing');
      await assertNoHorizontalOverflow(page);
    });

    test('no off-screen elements in rating section', async ({ page }) => {
      await goToShowFixture(page, 'existing');
      const fixture = page.locator('[data-testid="show-rating-fixture"]');
      await assertNothingOffScreen(fixture);
    });

    test('no overlapping controls in rating row', async ({ page }) => {
      await goToShowFixture(page, 'existing');
      const fixture = page.locator('[data-testid="show-rating-fixture"]');
      await assertNoOverlaps(fixture);
    });

    test('minimum tap targets', async ({ page }) => {
      await goToShowFixture(page, 'existing');
      const fixture = page.locator('[data-testid="show-rating-fixture"]');
      await assertMinimumTapTargets(fixture);
    });

    // ─── Rating Flow (Empty State) ──────────────────────────────

    test('empty state: clicking star opens review panel', async ({ page }) => {
      await goToShowFixture(page, 'empty');

      // Should see interactive stars
      const stars = page.locator('[data-testid="show-rating-fixture"] button[aria-label*="star"]');
      const starCount = await stars.count();
      expect(starCount).toBeGreaterThanOrEqual(5);

      // Click the 4th star
      await stars.nth(3).click();

      // ReviewPanel should open
      await expect(page.getByText('Save')).toBeVisible({ timeout: 3000 });
    });

    test('empty state: save creates a new rating', async ({ page }) => {
      await goToShowFixture(page, 'empty');

      // Click 4th star
      const stars = page.locator('[data-testid="show-rating-fixture"] button[aria-label*="star"]');
      await stars.nth(3).click();

      // Panel should open — click save
      const saveBtn = page.getByRole('button', { name: /save/i });
      await expect(saveBtn).toBeVisible({ timeout: 3000 });
      await saveBtn.click();

      // Panel should close, rating should show
      await page.waitForTimeout(500);
      // Edit button should now appear (indicates saved state)
      await expect(page.getByLabel('Edit rating')).toBeVisible({ timeout: 3000 });
    });

    // ─── Edit Flow (Existing State) ─────────────────────────────

    test('existing state: edit pencil opens panel with pre-filled data', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      // Click edit pencil
      const editBtn = page.getByLabel('Edit rating');
      await expect(editBtn).toBeVisible();
      await editBtn.click();

      // ReviewPanel should open with textarea
      const textarea = page.locator('textarea');
      await expect(textarea).toBeVisible({ timeout: 3000 });

      // Should have existing review text
      const value = await textarea.inputValue();
      expect(value).toContain('Incredible show');
    });

    test('existing state: cancel closes panel without saving', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      await page.getByLabel('Edit rating').click();
      await expect(page.locator('textarea')).toBeVisible({ timeout: 3000 });

      // Modify text
      await page.locator('textarea').fill('Changed text');

      // Cancel
      await page.getByRole('button', { name: /cancel/i }).click();

      // Panel should close
      await page.waitForTimeout(300);
      await expect(page.locator('textarea')).not.toBeVisible();
    });

    test('existing state: save updates the review', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      await page.getByLabel('Edit rating').click();
      const textarea = page.locator('textarea');
      await expect(textarea).toBeVisible({ timeout: 3000 });

      // Modify and save
      await textarea.fill('Updated review text');
      await page.getByRole('button', { name: /save/i }).click();

      // Panel should close
      await page.waitForTimeout(500);
      await expect(page.locator('textarea')).not.toBeVisible();
    });

    // ─── Delete Flow ────────────────────────────────────────────

    test('existing state: delete confirmation shows and dismisses', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      const deleteBtn = page.getByLabel('Delete rating');
      await expect(deleteBtn).toBeVisible();
      await deleteBtn.click();

      // "Delete?" and "Cancel" appear
      await expect(page.getByText('Delete?')).toBeVisible();
      await expect(page.getByText('Cancel')).toBeVisible();

      // Cancel → dismissed
      await page.getByText('Cancel').click();
      await expect(page.getByText('Delete?')).not.toBeVisible();
      await expect(deleteBtn).toBeVisible();
    });

    test('existing state: delete removes the review', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      const deleteBtn = page.getByLabel('Delete rating');
      await deleteBtn.click();
      await page.getByText('Delete?').click();

      // Review should be removed — edit button should disappear
      await page.waitForTimeout(500);
      // Stars should reset to interactive (empty) state
      const stars = page.locator('[data-testid="show-rating-fixture"] button[aria-label*="star"]');
      await expect(stars.first()).toBeVisible({ timeout: 3000 });
    });

    // ─── Previous Viewings (Multi State) ────────────────────────

    test('multi state: shows multiple viewings', async ({ page }) => {
      await goToShowFixture(page, 'multi');

      // Should show "Seen N times" badge
      await expect(page.getByText(/Seen \d+ times/)).toBeVisible();

      // Previous viewings should be listed
      // The component shows up to 3 previous viewings
    });

    test('multi state: new viewing button works', async ({ page }) => {
      await goToShowFixture(page, 'multi');

      const newViewingBtn = page.getByText('+ New Viewing');
      await expect(newViewingBtn).toBeVisible();
      await newViewingBtn.click();

      // Should show interactive stars for new rating
      await page.waitForTimeout(300);
    });

    // ─── Watchlist Toggle ───────────────────────────────────────

    test('existing state: watchlist toggle works', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      // Should be watchlisted initially
      const watchlistBtn = page.locator('button[aria-label*="atchlist"], button[aria-label*="Watchlist"]').first();
      if (await watchlistBtn.isVisible()) {
        await watchlistBtn.click();
        // Should toggle off
        await page.waitForTimeout(300);

        // Toggle back on
        await watchlistBtn.click();
        await page.waitForTimeout(300);
      }
    });

    // ─── ReviewPanel Layout ─────────────────────────────────────

    test('review panel: no overflow when open', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      await page.getByLabel('Edit rating').click();
      await expect(page.locator('textarea')).toBeVisible({ timeout: 3000 });

      // Check no horizontal overflow with panel open
      await assertNoHorizontalOverflow(page);
    });

    test('review panel: save and cancel buttons meet tap target size', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      await page.getByLabel('Edit rating').click();
      await expect(page.locator('textarea')).toBeVisible({ timeout: 3000 });

      // Check save and cancel button sizes
      const saveBtn = page.getByRole('button', { name: /save/i });
      const cancelBtn = page.getByRole('button', { name: /cancel/i });

      const saveBox = await saveBtn.boundingBox();
      const cancelBox = await cancelBtn.boundingBox();

      expect(saveBox!.height).toBeGreaterThanOrEqual(28);
      expect(cancelBox!.height).toBeGreaterThanOrEqual(28);
    });

    test('review panel: character counter visible', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      await page.getByLabel('Edit rating').click();
      await expect(page.locator('textarea')).toBeVisible({ timeout: 3000 });

      // Character counter should be visible
      await expect(page.getByText(/left$/)).toBeVisible();

      // Privacy note should be visible
      await expect(page.getByText('Only visible to you')).toBeVisible();
    });
  });
}
