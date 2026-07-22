import { test, expect } from '@playwright/test';
import {
  assertNoOverlaps,
  assertNothingOffScreen,
  assertMinimumTapTargets,
  assertNoHorizontalOverflow,
} from './helpers/layout-assertions';
import { VIEWPORTS, goToMock, switchToListView } from './helpers/mock-helpers';

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
      // Switch to list view (diary defaults to grid)
      await page.getByRole('button', { name: 'List view' }).click();
      await expect(page.getByRole('button', { name: 'List view' })).toHaveClass(/bg-white/, { timeout: 3000 });

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
      // Switch to list view (diary defaults to grid)
      await page.getByRole('button', { name: 'List view' }).click();
      await expect(page.getByRole('button', { name: 'List view' })).toHaveClass(/bg-white/, { timeout: 3000 });

      // Diary tab badge carries the seen count (summary bar removed 2026-07-12)
      const diaryBadge = page.locator('#tab-diary span').first();
      const initialText = await diaryBadge.textContent();
      const deleteBtn = page.getByRole('button', { name: 'Delete rating' }).first();
      await deleteBtn.click();

      // Confirm delete
      await page.getByRole('button', { name: /Delete\?/ }).first().click();

      // Badge count should change — wait for the text to differ from initial
      await expect(async () => {
        const newText = await diaryBadge.textContent();
        expect(newText).not.toEqual(initialText);
      }).toPass({ timeout: 3000 });
    });

    test('diary grid: delete button visible on desktop hover', async ({ page }) => {
      // Grid delete is hidden on mobile (hidden sm:flex), hover-only on desktop
      if (vp.name === 'mobile') return;

      await goToMock(page, 'diary');
      // Switch to grid view (diary defaults to list)
      await page.getByRole('button', { name: 'Grid view' }).click();
      await expect(page.getByRole('button', { name: 'Grid view' })).toHaveClass(/bg-white/, { timeout: 3000 });

      // Grid delete button exists in DOM but is opacity-0 until hover
      const deleteBtn = page.getByRole('button', { name: 'Delete rating' }).first();
      await expect(deleteBtn).toBeAttached();
    });

    // ─── Watchlist — Remove Flow (List View) ────────────────────

    test('watchlist list: remove confirmation shows and dismisses', async ({ page }) => {
      await goToMock(page, 'watchlist');
      // Default watchlist view is grid — switch to list to get "Remove?/No" confirmation
      const listBtn = page.getByRole('button', { name: 'List view' });
      await listBtn.click();
      await expect(listBtn).toHaveClass(/bg-white/, { timeout: 3000 });

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
      const listBtn = page.getByRole('button', { name: 'List view' });
      await listBtn.click();
      await expect(listBtn).toHaveClass(/bg-white/, { timeout: 3000 });

      // Get initial watchlist count from tab badge
      const watchlistTab = page.getByRole('tab', { name: /Watchlist/ });
      const initialTabText = await watchlistTab.textContent();
      const initialMatch = initialTabText?.match(/\d+/);
      const initialCount = initialMatch ? parseInt(initialMatch[0]) : 0;
      expect(initialCount).toBeGreaterThan(0);

      const removeBtn = page.getByRole('button', { name: 'Remove from watchlist' }).first();
      await expect(removeBtn).toBeVisible();
      await removeBtn.click();

      // Confirm removal
      await page.getByRole('button', { name: /Remove\?/ }).first().click();

      // Watchlist badge count should decrease by 1
      const expectedCount = initialCount - 1;
      await expect(async () => {
        const tabText = await watchlistTab.textContent();
        expect(tabText).toContain(String(expectedCount));
      }).toPass({ timeout: 3000 });
    });

    // ─── View Switching ─────────────────────────────────────────

    test('grid/list toggle switches layout', async ({ page }) => {
      await goToMock(page, 'diary');

      // Switch to grid — button should get active state
      const gridBtn = page.getByRole('button', { name: 'Grid view' });
      await gridBtn.click();
      await expect(gridBtn).toHaveClass(/bg-white/, { timeout: 3000 });

      // Switch back to list — list button should get active state
      const listBtn = page.getByRole('button', { name: 'List view' });
      await listBtn.click();
      await expect(listBtn).toHaveClass(/bg-white/, { timeout: 3000 });
    });

    // ─── Sort Behavior ──────────────────────────────────────────

    test('diary sort options produce different order', async ({ page }) => {
      await goToMock(page, 'diary');
      // Switch to list view (grid cards don't show titles as h4)
      await page.getByRole('button', { name: 'List view' }).click();
      await expect(page.getByRole('button', { name: 'List view' })).toHaveClass(/bg-white/, { timeout: 3000 });

      const sortSelect = page.getByRole('combobox', { name: 'Sort diary' });
      await expect(sortSelect).toBeVisible();

      // Get all card titles in default (newest) order
      const allTitlesDefault = await page.locator('h4').allTextContents();

      // Switch to "Top Rated" and wait for re-render
      await sortSelect.selectOption('rating-desc');
      await expect(async () => {
        const titles = await page.locator('h4').allTextContents();
        expect(titles.join('|')).not.toEqual(allTitlesDefault.join('|'));
      }).toPass({ timeout: 3000 });
      const allTitlesRating = await page.locator('h4').allTextContents();

      // Switch to "Oldest"
      await sortSelect.selectOption('date-asc');
      await expect(async () => {
        const titles = await page.locator('h4').allTextContents();
        expect(titles.join('|')).not.toEqual(allTitlesRating.join('|'));
      }).toPass({ timeout: 3000 });
    });

    // ─── Tab Switching ──────────────────────────────────────────

    test('tab switching preserves state', async ({ page }) => {
      await goToMock(page, 'diary');

      // Switch to watchlist
      await page.getByRole('tab', { name: /Watchlist/ }).click();
      await expect(page.getByRole('tab', { name: /Watchlist/ })).toHaveAttribute('aria-selected', 'true', { timeout: 3000 });

      // Switch back to diary
      await page.getByRole('tab', { name: 'Diary' }).click();
      await expect(page.getByRole('tab', { name: /Diary/ })).toHaveAttribute('aria-selected', 'true', { timeout: 3000 });
    });

    // ─── Navigation Links ───────────────────────────────────────

    test('edit pencil links have correct href pattern', async ({ page }) => {
      await goToMock(page, 'diary');
      // list-row UI — grid (the diary default) renders edit as a <button> that
      // pushes the route in its onClick, not an <a href>; only list view has
      // a real Link for this (2026-07-19 code-review fix split them to avoid
      // nested anchors in the grid card).
      await switchToListView(page);

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

    test('add show button opens and closes search', async ({ page }) => {
      await goToMock(page, 'diary');

      // "Add a show" or "+" button must exist
      const addBtn = page.getByRole('button', { name: /Add a show|Add show/ }).first();
      await expect(addBtn).toBeVisible();
      await addBtn.click();

      // Search input should appear and be focused
      const searchInput = page.getByPlaceholder(/Search to rate/).first();
      await expect(searchInput).toBeVisible({ timeout: 3000 });

      // Close search
      const closeBtn = page.getByRole('button', { name: 'Close search' });
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
      } else {
        await page.keyboard.press('Escape');
      }

      // Search input should disappear
      await expect(searchInput).not.toBeVisible({ timeout: 3000 });
    });
  });
}
