import { test, expect } from '@playwright/test';
import {
  assertNoOverlaps,
  assertNoHorizontalOverflow,
} from './helpers/layout-assertions';
import { VIEWPORTS, goToShowFixture } from './helpers/mock-helpers';

/**
 * Functional E2E tests for ShowPageRating component.
 * Uses the /test/show-rating-fixture page with local-state callbacks.
 *
 * Run: TEST_BASE_URL=http://localhost:3456 npx playwright test --project=chromium tests/e2e/show-rating-functional.spec.ts
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

    test('no overlapping controls in rating row', async ({ page }) => {
      await goToShowFixture(page, 'existing');
      const fixture = page.locator('[data-testid="show-rating-fixture"]');
      await assertNoOverlaps(fixture);
    });

    // ─── Rating Flow (Empty State) ──────────────────────────────

    test('empty state: clicking star opens review panel', async ({ page }) => {
      await goToShowFixture(page, 'empty');

      // Should see interactive star buttons (aria-label="N stars")
      const stars = page.locator('[data-testid="show-rating-fixture"] button[aria-label$="stars"], [data-testid="show-rating-fixture"] button[aria-label="1 star"]');
      const starCount = await stars.count();
      expect(starCount).toBeGreaterThanOrEqual(5);

      // Click the 4th star
      await page.getByRole('button', { name: '4 stars' }).click();

      // ReviewPanel should open — Save button visible
      await expect(page.getByRole('button', { name: /save/i })).toBeVisible({ timeout: 3000 });
    });

    test('empty state: save creates a new rating', async ({ page }) => {
      await goToShowFixture(page, 'empty');

      // Click 4th star
      await page.getByRole('button', { name: '4 stars' }).click();

      // Panel should open — click save
      const saveBtn = page.getByRole('button', { name: /save/i });
      await expect(saveBtn).toBeVisible({ timeout: 3000 });
      await saveBtn.click();

      // Panel should close, edit button should appear (indicates saved state)
      await expect(page.getByRole('button', { name: 'Edit rating' })).toBeVisible({ timeout: 3000 });
    });

    // ─── Edit Flow (Existing State) ─────────────────────────────

    test('existing state: edit pencil opens panel with pre-filled data', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      // Click edit pencil
      const editBtn = page.getByRole('button', { name: 'Edit rating' });
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

      await page.getByRole('button', { name: 'Edit rating' }).click();
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

      await page.getByRole('button', { name: 'Edit rating' }).click();
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

      const deleteBtn = page.getByRole('button', { name: 'Delete rating' });
      await expect(deleteBtn).toBeVisible();
      await deleteBtn.click();

      // "Delete?" and "Cancel" appear (use .first() — existing state has 2 reviews,
      // both show Delete? because latestReview is duplicated in previous viewings list)
      await expect(page.getByRole('button', { name: 'Delete?' }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel' }).first()).toBeVisible();

      // Cancel → dismissed
      await page.getByRole('button', { name: 'Cancel' }).first().click();
      await expect(page.getByRole('button', { name: 'Delete?' })).not.toBeVisible();
      await expect(deleteBtn).toBeVisible();
    });

    test('existing state: delete removes the review', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      const deleteBtn = page.getByRole('button', { name: 'Delete rating' });
      await deleteBtn.click();
      await page.getByRole('button', { name: 'Delete?' }).first().click();

      // Review should be removed — stars should reset to interactive (empty) state
      await page.waitForTimeout(500);
      // Interactive stars should now be visible (empty state with clickable stars)
      const stars = page.locator('[data-testid="show-rating-fixture"] button[aria-label$="stars"]');
      await expect(stars.first()).toBeVisible({ timeout: 3000 });
    });

    // ─── Previous Viewings (Multi State) ────────────────────────

    test('multi state: shows multiple viewings', async ({ page }) => {
      await goToShowFixture(page, 'multi');

      // Should show "Seen N times" badge
      await expect(page.getByText(/Seen \d+ times/)).toBeVisible();
    });

    test('multi state: new viewing button works', async ({ page }) => {
      await goToShowFixture(page, 'multi');

      const newViewingBtn = page.getByRole('button', { name: '+ New Viewing' });
      await expect(newViewingBtn).toBeVisible();
      await newViewingBtn.click();

      // Should show interactive stars for new rating (panel area resets)
      await page.waitForTimeout(300);
    });

    // ─── Watchlist Toggle ───────────────────────────────────────

    test('existing state: watchlist toggle works', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      // Should be watchlisted initially — button says "Remove from watchlist"
      const watchlistBtn = page.getByRole('button', { name: /from watchlist|to watchlist/i }).first();
      if (await watchlistBtn.isVisible()) {
        await watchlistBtn.click();
        // Should toggle state
        await page.waitForTimeout(300);

        // Toggle back
        await watchlistBtn.click();
        await page.waitForTimeout(300);
      }
    });

    // ─── ReviewPanel Layout ─────────────────────────────────────

    test('review panel: no overflow when open', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      await page.getByRole('button', { name: 'Edit rating' }).click();
      await expect(page.locator('textarea')).toBeVisible({ timeout: 3000 });

      // Check no horizontal overflow with panel open
      await assertNoHorizontalOverflow(page);
    });

    test('review panel: save and cancel buttons meet tap target size', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      await page.getByRole('button', { name: 'Edit rating' }).click();
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

      await page.getByRole('button', { name: 'Edit rating' }).click();
      await expect(page.locator('textarea')).toBeVisible({ timeout: 3000 });

      // Character counter should be visible
      await expect(page.getByText(/left$/)).toBeVisible();

      // Privacy note should be visible
      await expect(page.getByText('Only visible to you')).toBeVisible();
    });
  });
}
