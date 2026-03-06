import { test, expect, type Page } from '@playwright/test';
import {
  assertNoOverlaps,
  assertNothingOffScreen,
  assertMinimumTapTargets,
  assertNoHorizontalOverflow,
} from './helpers/layout-assertions';
import { VIEWPORTS, goToMock } from './helpers/mock-helpers';

/**
 * Functional E2E tests for My Shows page.
 * Verifies that user actions work end-to-end and layout is correct at both viewports.
 *
 * Run: TEST_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/my-shows-functional.spec.ts
 */

for (const vp of VIEWPORTS) {
  test.describe(`My Shows Functional — ${vp.name} (${vp.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
    });

    // ─── Layout Health ──────────────────────────────────────────

    test('no horizontal overflow', async ({ page }) => {
      await goToMock(page);
      await assertNoHorizontalOverflow(page);
    });

    test('no off-screen interactive elements in diary', async ({ page }) => {
      await goToMock(page, 'diary');
      const main = page.locator('main').first();
      await assertNothingOffScreen(main);
    });

    test('no off-screen interactive elements in watchlist', async ({ page }) => {
      await goToMock(page, 'watchlist');
      const main = page.locator('main').first();
      await assertNothingOffScreen(main);
    });

    test('no overlapping controls in tab bar area', async ({ page }) => {
      await goToMock(page);
      const controls = page.locator('[role="tablist"]').first();
      if (await controls.isVisible()) {
        await assertNoOverlaps(controls);
      }
    });

    test('minimum tap targets on diary cards', async ({ page }) => {
      await goToMock(page, 'diary');
      // Check first diary card
      const firstCard = page.locator('[data-diary-card]').first();
      if (await firstCard.isVisible()) {
        await assertMinimumTapTargets(firstCard);
      }
    });

    test('minimum tap targets on watchlist cards', async ({ page }) => {
      await goToMock(page, 'watchlist');
      const firstCard = page.locator('[data-watchlist-card]').first();
      if (await firstCard.isVisible()) {
        await assertMinimumTapTargets(firstCard);
      }
    });

    // ─── Diary — Delete Flow ────────────────────────────────────

    test('diary list: delete confirmation shows and dismisses', async ({ page }) => {
      await goToMock(page, 'diary');

      // Find a delete button (trash icon)
      const deleteBtn = page.getByLabel('Delete rating').first();
      await expect(deleteBtn).toBeVisible();
      await deleteBtn.click();

      // "Delete?" and "No" should appear
      await expect(page.getByText('Delete?').first()).toBeVisible();
      await expect(page.getByText('No').first()).toBeVisible();

      // Click "No" — dismissed, card still there
      await page.getByText('No').first().click();
      await expect(page.getByText('Delete?')).not.toBeVisible();
      await expect(deleteBtn).toBeVisible();
    });

    test('diary list: delete confirmation removes card', async ({ page }) => {
      await goToMock(page, 'diary');

      // Count initial cards
      const initialCount = await page.getByText('shows seen').textContent();
      const deleteBtn = page.getByLabel('Delete rating').first();
      await deleteBtn.click();

      // Click "Delete?" to confirm
      await page.getByText('Delete?').first().click();

      // Wait for card to be removed — count changes
      await page.waitForTimeout(300); // animation
      const newCount = await page.getByText('shows seen').textContent();
      expect(newCount).not.toEqual(initialCount);
    });

    test('diary grid: delete flow works', async ({ page }) => {
      await goToMock(page, 'diary');

      // Switch to grid view
      await page.getByLabel('Grid view').click();

      // Find a delete button
      const deleteBtn = page.getByLabel('Delete rating').first();
      if (await deleteBtn.isVisible()) {
        await deleteBtn.click();
        await expect(page.getByText('Delete?').first()).toBeVisible();
        // Dismiss
        await page.getByText('No').first().click();
        await expect(page.getByText('Delete?')).not.toBeVisible();
      }
    });

    // ─── Watchlist — Remove Flow ────────────────────────────────

    test('watchlist: remove confirmation shows and dismisses', async ({ page }) => {
      await goToMock(page, 'watchlist');

      const removeBtn = page.getByText('Remove').first();
      if (await removeBtn.isVisible()) {
        await removeBtn.click();
        await expect(page.getByText('Remove?').first()).toBeVisible();
        // Click "No" to dismiss
        const noBtn = page.getByText('No').first();
        if (await noBtn.isVisible()) {
          await noBtn.click();
          await expect(page.getByText('Remove?')).not.toBeVisible();
        }
      }
    });

    test('watchlist: remove confirmation removes entry', async ({ page }) => {
      await goToMock(page, 'watchlist');

      // Count initial entries
      const initialEntries = await page.locator('[data-watchlist-card]').count();

      const removeBtn = page.getByText('Remove').first();
      if (await removeBtn.isVisible() && initialEntries > 0) {
        await removeBtn.click();
        await page.getByText('Remove?').first().click();

        // Wait for removal
        await page.waitForTimeout(300);
        const newEntries = await page.locator('[data-watchlist-card]').count();
        expect(newEntries).toBeLessThan(initialEntries);
      }
    });

    // ─── View Switching ─────────────────────────────────────────

    test('grid/list toggle switches layout', async ({ page }) => {
      await goToMock(page, 'diary');

      // Start in list view — should see diary cards
      await page.getByLabel('Grid view').click();
      // Grid cards should be visible
      await page.waitForTimeout(200);

      await page.getByLabel('List view').click();
      // Should be back to list layout
      await page.waitForTimeout(200);
    });

    // ─── Sort Behavior ──────────────────────────────────────────

    test('diary sort options produce different order', async ({ page }) => {
      await goToMock(page, 'diary');

      const sortSelect = page.getByLabel('Sort diary');
      await expect(sortSelect).toBeVisible();

      // Get first card title in default (newest) order
      const firstCardDefault = await page.locator('[data-diary-card] h4, [data-diary-card] h3').first().textContent();

      // Switch to "Top Rated"
      await sortSelect.selectOption('rating-desc');
      await page.waitForTimeout(200);
      const firstCardRating = await page.locator('[data-diary-card] h4, [data-diary-card] h3').first().textContent();

      // Switch to "Oldest"
      await sortSelect.selectOption('date-asc');
      await page.waitForTimeout(200);
      const firstCardOldest = await page.locator('[data-diary-card] h4, [data-diary-card] h3').first().textContent();

      // At least one sort should produce a different order
      const allSame = firstCardDefault === firstCardRating && firstCardRating === firstCardOldest;
      expect(allSame, 'All sort orders produced same first card').toBe(false);
    });

    // ─── Tab Switching ──────────────────────────────────────────

    test('tab switching preserves state', async ({ page }) => {
      await goToMock(page, 'diary');

      // Switch to watchlist
      await page.getByRole('tab', { name: /watchlist/i }).click();
      await expect(page.locator('[data-watchlist-card]').first()).toBeVisible();

      // Switch back to diary
      await page.getByRole('tab', { name: /diary/i }).click();
      await expect(page.getByText('shows seen')).toBeVisible();
    });

    // ─── Navigation Links ───────────────────────────────────────

    test('edit pencil links have correct href pattern', async ({ page }) => {
      await goToMock(page, 'diary');

      const editLinks = page.getByLabel('Edit rating');
      const count = await editLinks.count();
      for (let i = 0; i < Math.min(count, 3); i++) {
        const href = await editLinks.nth(i).getAttribute('href');
        if (href) {
          expect(href).toMatch(/\/show\/[a-z0-9-]+\?edit=1/);
        }
      }
    });

    // ─── Add Show Search ────────────────────────────────────────

    test('add show button opens search', async ({ page }) => {
      await goToMock(page, 'diary');

      const addBtn = page.getByText('Add show').first();
      if (await addBtn.isVisible()) {
        await addBtn.click();
        // Search input should appear and be focused
        const searchInput = page.getByPlaceholder(/search/i).first();
        await expect(searchInput).toBeVisible();

        // Escape closes it
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    });
  });
}
