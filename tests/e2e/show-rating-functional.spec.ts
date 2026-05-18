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

      const card = page.locator('[data-testid="rating-card"]');
      // Should see interactive star buttons (aria-label="N stars")
      const stars = card.locator('button[aria-label$="stars"], button[aria-label="1 star"]');
      const starCount = await stars.count();
      expect(starCount).toBeGreaterThanOrEqual(5);

      // Click the 4th star (scoped to rating card, not star showcase)
      await card.getByRole('button', { name: '4 stars' }).click();

      // ReviewPanel should open — Save button visible
      await expect(page.getByRole('button', { name: /save/i })).toBeVisible({ timeout: 3000 });
    });

    test('empty state: save creates a new rating', async ({ page }) => {
      await goToShowFixture(page, 'empty');

      const card = page.locator('[data-testid="rating-card"]');
      // Click 4th star (scoped to rating card)
      await card.getByRole('button', { name: '4 stars' }).click();

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

      // Panel should close — textarea disappears
      await expect(page.locator('textarea')).not.toBeVisible({ timeout: 3000 });
    });

    test('existing state: save updates the review', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      await page.getByRole('button', { name: 'Edit rating' }).click();
      const textarea = page.locator('textarea');
      await expect(textarea).toBeVisible({ timeout: 3000 });

      // Modify and save
      await textarea.fill('Updated review text');
      await page.getByRole('button', { name: /save/i }).click();

      // Panel should close — textarea disappears, edit button returns
      await expect(page.locator('textarea')).not.toBeVisible({ timeout: 3000 });
      await expect(page.getByRole('button', { name: 'Edit rating' })).toBeVisible({ timeout: 3000 });
    });

    // ─── Delete Flow ────────────────────────────────────────────

    test('existing state: delete confirmation shows and dismisses', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      const deleteBtn = page.getByRole('button', { name: 'Delete rating' });
      await expect(deleteBtn).toBeVisible();
      await deleteBtn.click();

      // "Delete?" and "Cancel" appear
      await expect(page.getByRole('button', { name: 'Delete?' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();

      // Cancel → dismissed
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('button', { name: 'Delete?' })).not.toBeVisible();
      await expect(deleteBtn).toBeVisible();
    });

    test('existing state: delete removes the review', async ({ page }) => {
      await goToShowFixture(page, 'existing');

      const deleteBtn = page.getByRole('button', { name: 'Delete rating' });
      await deleteBtn.click();
      await page.getByRole('button', { name: 'Delete?' }).click();

      // Review should be removed — interactive stars should appear (empty state)
      const stars = page.locator('[data-testid="show-rating-fixture"] button[aria-label$="stars"]');
      await expect(stars.first()).toBeVisible({ timeout: 3000 });
    });

    // ─── Previous Viewings (Multi State) ────────────────────────

    test('multi state: shows multiple viewings', async ({ page }) => {
      await goToShowFixture(page, 'multi');

      // Should show "Seen N times" badge
      await expect(page.getByText(/Seen \d+ times/)).toBeVisible();
    });

    test('multi state: new viewing button opens panel with interactive stars', async ({ page }) => {
      await goToShowFixture(page, 'multi');

      const newViewingBtn = page.getByRole('button', { name: '+ New Viewing' });
      await expect(newViewingBtn).toBeVisible();
      await newViewingBtn.click();

      // After clicking "+ New Viewing", the panel should reset to show interactive stars
      // (the existing filled stars disappear, replaced by clickable empty stars)
      const interactiveStars = page.locator('[data-testid="show-rating-fixture"] button[aria-label$="stars"]');
      await expect(interactiveStars.first()).toBeVisible({ timeout: 3000 });
    });

    test('multi state: latestReview not duplicated in previous viewings', async ({ page }) => {
      await goToShowFixture(page, 'multi');

      // Multi state has 4 reviews. The latest (5.0 stars) shows in the main row.
      // Previous viewings should show the other 3, NOT including the latest.
      if (vp.width >= 640) {
        // Desktop: edit buttons visible on hover — count should be exactly 3
        const editViewingBtns = page.getByRole('button', { name: 'Edit this viewing' });
        await expect(editViewingBtns).toHaveCount(3);
      } else {
        // Mobile: edit/trash buttons hidden (sm:flex). Count dates only in previous-viewings section.
        const dates = page.locator('[data-testid="previous-viewings"]').locator('text=/\\w+ \\d+, \\d{4}/');
        await expect(dates).toHaveCount(3, { timeout: 3000 });
      }
    });

    // Watchlist toggle test removed — fixture doesn't include WatchlistButton
    // (watchlist is tested on the actual show page, not the isolated rating fixture)

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
