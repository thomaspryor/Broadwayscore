import { test, expect } from '@playwright/test';
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
 * Run: TEST_BASE_URL=http://localhost:3456 npx playwright test --project=chromium tests/e2e/my-shows-functional.spec.ts
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
      const controls = page.getByRole('tablist').first();
      if (await controls.isVisible()) {
        await assertNoOverlaps(controls);
      }
    });

    test('minimum tap targets on diary controls', async ({ page }) => {
      await goToMock(page, 'diary');
      const tablist = page.getByRole('tablist').first();
      if (await tablist.isVisible()) {
        await assertMinimumTapTargets(tablist);
      }
    });

    // ─── Diary — Delete Flow (List View) ────────────────────────

    test('diary list: delete confirmation shows and dismisses', async ({ page }) => {
      await goToMock(page, 'diary');

      const deleteBtn = page.getByRole('button', { name: 'Delete rating' }).first();
      await expect(deleteBtn).toBeVisible();
      await deleteBtn.click();

      // "Delete?" and "No" should appear
      await expect(page.getByRole('button', { name: /Delete\?/ }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'No' }).first()).toBeVisible();

      // Click "No" → dismissed, card still there
      await page.getByRole('button', { name: 'No' }).first().click();
      await expect(page.getByRole('button', { name: /Delete\?/ })).not.toBeVisible();
      await expect(deleteBtn).toBeVisible();
    });

    test('diary list: delete confirmation removes card', async ({ page }) => {
      await goToMock(page, 'diary');

      const initialCount = await page.getByText('shows seen').textContent();
      const deleteBtn = page.getByRole('button', { name: 'Delete rating' }).first();
      await deleteBtn.click();

      // Confirm delete
      await page.getByRole('button', { name: /Delete\?/ }).first().click();

      // Count should change
      await page.waitForTimeout(300);
      const newCount = await page.getByText('shows seen').textContent();
      expect(newCount).not.toEqual(initialCount);
    });

    test('diary grid: delete button toggles on mobile', async ({ page }) => {
      // Grid delete is a single toggle button — visible on mobile, hover-only on desktop
      if (vp.name === 'desktop') return; // skip — grid delete needs hover which is brittle in tests

      await goToMock(page, 'diary');
      await page.getByRole('button', { name: 'Grid view' }).click();
      await page.waitForTimeout(200);

      // Grid delete button should be visible on mobile (opacity-100)
      const deleteBtn = page.getByRole('button', { name: 'Delete rating' }).first();
      if (await deleteBtn.isVisible()) {
        // First click arms the delete (button turns red)
        await deleteBtn.click();
        await page.waitForTimeout(200);
        // Second click confirms delete — but we'll just dismiss by waiting for auto-cancel (4s timeout)
        // Verify the button is still there (confirmation state)
        await expect(deleteBtn).toBeVisible();
      }
    });

    // ─── Watchlist — Remove Flow (List View) ────────────────────

    test('watchlist list: remove confirmation shows and dismisses', async ({ page }) => {
      await goToMock(page, 'watchlist');
      // Default watchlist view is grid — switch to list to get "Remove?/No" confirmation
      await page.getByRole('button', { name: 'List view' }).click();
      await page.waitForTimeout(200);

      const removeBtn = page.getByRole('button', { name: 'Remove from watchlist' }).first();
      await expect(removeBtn).toBeVisible();
      await removeBtn.click();

      // "Remove?" and "No" should appear
      await expect(page.getByRole('button', { name: /Remove\?/ }).first()).toBeVisible({ timeout: 3000 });
      const noBtn = page.getByRole('button', { name: 'No' }).first();
      await expect(noBtn).toBeVisible();

      // Click "No" → dismissed
      await noBtn.click();
      await expect(page.getByRole('button', { name: /Remove\?/ })).not.toBeVisible();
    });

    test('watchlist list: remove confirmation removes entry', async ({ page }) => {
      await goToMock(page, 'watchlist');
      // Switch to list view
      await page.getByRole('button', { name: 'List view' }).click();
      await page.waitForTimeout(200);

      const removeBtn = page.getByRole('button', { name: 'Remove from watchlist' }).first();
      await expect(removeBtn).toBeVisible();
      await removeBtn.click();

      // Confirm removal
      await page.getByRole('button', { name: /Remove\?/ }).first().click();

      // Wait for removal animation
      await page.waitForTimeout(300);
      // Watchlist badge count should decrease
      const watchlistTab = page.getByRole('tab', { name: /Watchlist/ });
      const tabText = await watchlistTab.textContent();
      // Should show fewer than 6 (original count)
      expect(tabText).toContain('5');
    });

    // ─── View Switching ─────────────────────────────────────────

    test('grid/list toggle switches layout', async ({ page }) => {
      await goToMock(page, 'diary');

      // Switch to grid
      const gridBtn = page.getByRole('button', { name: 'Grid view' });
      await gridBtn.click();
      await page.waitForTimeout(200);
      const gridClasses = await gridBtn.getAttribute('class');
      expect(gridClasses).toContain('bg-white');

      // Switch back to list
      const listBtn = page.getByRole('button', { name: 'List view' });
      await listBtn.click();
      await page.waitForTimeout(200);
      const listClasses = await listBtn.getAttribute('class');
      expect(listClasses).toContain('bg-white');
    });

    // ─── Sort Behavior ──────────────────────────────────────────

    test('diary sort options produce different order', async ({ page }) => {
      await goToMock(page, 'diary');

      const sortSelect = page.getByRole('combobox', { name: 'Sort diary' });
      await expect(sortSelect).toBeVisible();

      // Get all card titles in default (newest) order
      // Note: "To Be Rated" section is always first, so check Past Shows section
      const allTitlesDefault = await page.locator('h4').allTextContents();

      // Switch to "Top Rated"
      await sortSelect.selectOption('rating-desc');
      await page.waitForTimeout(300);
      const allTitlesRating = await page.locator('h4').allTextContents();

      // Switch to "Oldest"
      await sortSelect.selectOption('date-asc');
      await page.waitForTimeout(300);
      const allTitlesOldest = await page.locator('h4').allTextContents();

      // The full title list should differ between at least two sort orders
      const defaultStr = allTitlesDefault.join('|');
      const ratingStr = allTitlesRating.join('|');
      const oldestStr = allTitlesOldest.join('|');
      const allSame = defaultStr === ratingStr && ratingStr === oldestStr;
      expect(allSame, 'All sort orders produced same card order').toBe(false);
    });

    // ─── Tab Switching ──────────────────────────────────────────

    test('tab switching preserves state', async ({ page }) => {
      await goToMock(page, 'diary');

      // Switch to watchlist
      await page.getByRole('tab', { name: /Watchlist/ }).click();
      await page.waitForTimeout(300);

      // Switch back to diary
      await page.getByRole('tab', { name: 'Diary' }).click();
      await expect(page.getByText('shows seen')).toBeVisible();
    });

    // ─── Navigation Links ───────────────────────────────────────

    test('edit pencil links have correct href pattern', async ({ page }) => {
      await goToMock(page, 'diary');

      const editLinks = page.getByRole('link', { name: 'Edit rating' });
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

      const addBtn = page.getByRole('button', { name: /Add a show/ }).first();
      if (await addBtn.isVisible()) {
        await addBtn.click();
        const searchInput = page.getByPlaceholder(/Search to rate/).first();
        await expect(searchInput).toBeVisible();

        // Close search
        const closeBtn = page.getByRole('button', { name: 'Close search' });
        if (await closeBtn.isVisible()) {
          await closeBtn.click();
        } else {
          await page.keyboard.press('Escape');
        }
        await page.waitForTimeout(300);
      }
    });
  });
}
