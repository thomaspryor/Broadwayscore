import { test, expect, type Page } from '@playwright/test';


/**
 * Comprehensive E2E tests for the My Shows page using mock mode.
 *
 * Mock mode (?mock=1 on localhost) bypasses auth and feature flags,
 * injecting deterministic fake data for reliable testing.
 *
 * Run locally: TEST_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/my-shows-mock.spec.ts
 * Or via npm script: npm run test:my-shows
 *
 * These tests verify:
 * - Page structure and content rendering
 * - Tab switching (Diary ↔ Watchlist)
 * - Grid/List view toggle
 * - Sort functionality (Newest, Oldest, Top Rated, A-Z, Closing)
 * - All three diary sections (To Be Rated, Upcoming, Past Shows)
 * - Interactive stars on To Be Rated cards
 * - Delete confirmation flow with auto-dismiss
 * - ARIA accessibility (tab roles, labels)
 * - Responsive layouts (mobile 390px + desktop 1440px)
 * - No console errors
 */

const MOCK_URL = '/my-shows?mock=1';

// Helper: wait for mock data to load
async function waitForMockData(page: Page) {
  await page.waitForSelector('text=shows seen', { timeout: 10000 });
}

// Helper: navigate to mock page and wait for data
async function goToMock(page: Page, tab: 'diary' | 'watchlist' = 'diary') {
  await page.goto(`${MOCK_URL}&tab=${tab}`);
  await waitForMockData(page);
}

// ─── Page Load & Structure ─────────────────────────────────────

test.describe('My Shows — Page Structure', () => {
  test('loads with correct title and header', async ({ page }) => {
    await goToMock(page);
    await expect(page).toHaveTitle(/My Shows/);
    await expect(page.getByRole('heading', { name: 'My Shows', level: 1 })).toBeVisible();
  });

  test('stats bar shows correct counts', async ({ page }) => {
    await goToMock(page);
    // Stats bar contains "X shows seen", "X watchlist", "X to rate"
    await expect(page.getByText('shows seen')).toBeVisible();
    await expect(page.getByText('9', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('watchlist').first()).toBeVisible();
    await expect(page.getByText('to rate')).toBeVisible();
  });

  test('no console errors on page load', async ({ page }) => {
    const errors: string[] = [];
    const notFoundUrls: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('response', response => {
      if (response.status() === 404) {
        const url = response.url();
        // Ignore expected 404s: favicon, analytics, external services
        if (!url.includes('favicon') && !url.includes('analytics') && !url.includes('supabase') && !url.includes('_vercel')) {
          notFoundUrls.push(`404: ${url}`);
        }
      }
    });
    await goToMock(page);
    const critical = errors.filter(e =>
      !e.includes('favicon') && !e.includes('analytics') && !e.includes('DevTools') &&
      !e.includes('Failed to load resource') // covered by notFoundUrls check below
    );
    expect([...critical, ...notFoundUrls], 'Unexpected errors or 404s on page load').toEqual([]);
  });
});

// ─── ARIA Accessibility ────────────────────────────────────────

test.describe('My Shows — Accessibility', () => {
  test('tab bar uses proper ARIA roles', async ({ page }) => {
    await goToMock(page);
    // tablist container
    await expect(page.getByRole('tablist')).toBeVisible();
    // Diary tab with selected state
    const diaryTab = page.getByRole('tab', { name: 'Diary' });
    await expect(diaryTab).toBeVisible();
    await expect(diaryTab).toHaveAttribute('aria-selected', 'true');
    // Watchlist tab not selected
    const watchlistTab = page.getByRole('tab', { name: /Watchlist/ });
    await expect(watchlistTab).toBeVisible();
    await expect(watchlistTab).toHaveAttribute('aria-selected', 'false');
  });

  test('tabpanel has correct role and label', async ({ page }) => {
    await goToMock(page);
    const panel = page.getByRole('tabpanel');
    await expect(panel).toBeVisible();
  });

  test('sort dropdowns have aria-labels', async ({ page }) => {
    await goToMock(page);
    await expect(page.getByRole('combobox', { name: 'Sort diary' })).toBeVisible();
    // Switch to watchlist
    await page.getByRole('tab', { name: /Watchlist/ }).click();
    await expect(page.getByRole('combobox', { name: 'Sort watchlist' })).toBeVisible();
  });

  test('star ratings have proper radiogroup role', async ({ page }) => {
    await goToMock(page);
    const starGroups = page.getByRole('radiogroup', { name: 'Star rating' });
    // 2 To Be Rated cards should each have a star rating group
    expect(await starGroups.count()).toBeGreaterThanOrEqual(2);
  });

  test('grid/list toggle buttons have aria-labels', async ({ page }) => {
    await goToMock(page);
    await expect(page.getByRole('button', { name: 'Grid view' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'List view' })).toBeVisible();
  });
});

// ─── Diary Tab — All Three Sections ────────────────────────────

test.describe('My Shows — Diary Sections', () => {
  test('To Be Rated section shows correct items', async ({ page }) => {
    await goToMock(page);
    await expect(page.getByRole('heading', { name: 'To Be Rated' })).toBeVisible();
    await expect(page.getByText('You saw these shows')).toBeVisible();
    // Ragtime and Chess are the to-be-rated items
    await expect(page.getByRole('heading', { name: 'Ragtime', level: 4 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Chess', level: 4 })).toBeVisible();
  });

  test('Upcoming section shows future watchlist items', async ({ page }) => {
    await goToMock(page);
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible();
    // Gypsy (Sep 15) and Smash (Oct 10)
    await expect(page.getByRole('heading', { name: 'Gypsy', level: 4 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Smash', level: 4 })).toBeVisible();
  });

  test('Past Shows section shows all rated shows', async ({ page }) => {
    await goToMock(page);
    await expect(page.getByRole('heading', { name: 'Past Shows' })).toBeVisible();
    // All 7 reviewed shows
    await expect(page.getByRole('heading', { name: 'Wicked', level: 4 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hamilton', level: 4 })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Cabaret/, level: 4 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Merrily We Roll Along', level: 4 })).toBeVisible();
  });

  test('To Be Rated stars are interactive', async ({ page }) => {
    await goToMock(page);
    // Click 4-star on Ragtime
    const ragtime = page.locator('text=Ragtime').first().locator('..').locator('..');
    const fourStar = page.getByRole('button', { name: '4 stars' }).first();
    await expect(fourStar).toBeVisible();
    // Click should navigate to show page with rate param
    const [newPage] = await Promise.all([
      page.waitForEvent('popup').catch(() => null),
      fourStar.click(),
    ]);
    // Should navigate (URL will contain rate=1&stars=4)
    await page.waitForURL(/rate=1/, { timeout: 5000 }).catch(() => {});
    const url = page.url();
    expect(url).toContain('/show/ragtime');
  });

  test('venue is displayed in diary list view', async ({ page }) => {
    await goToMock(page);
    // Diary list view should show venue names instead of badges
    const venues = page.locator('.text-gray-500').filter({ hasText: /Theatre|Theater/ });
    expect(await venues.count()).toBeGreaterThan(0);
  });

  test('review text is displayed for shows with notes', async ({ page }) => {
    await goToMock(page);
    await expect(page.getByText('Incredible production, Elphaba was phenomenal.')).toBeVisible();
    await expect(page.getByText('Good but not great revival.')).toBeVisible();
  });

  test('edit links point to correct show pages', async ({ page }) => {
    await goToMock(page);
    const editLinks = page.getByRole('link', { name: 'Edit rating' });
    const count = await editLinks.count();
    expect(count).toBe(9); // 9 rated shows in mock data
    // First edit link should include ?edit=1
    const firstHref = await editLinks.first().getAttribute('href');
    expect(firstHref).toContain('?edit=1');
  });
});

// ─── Sorting ───────────────────────────────────────────────────

test.describe('My Shows — Sorting', () => {
  test('diary "Top Rated" sort orders correctly', async ({ page }) => {
    await goToMock(page);
    await page.getByRole('combobox', { name: 'Sort diary' }).selectOption('rating-desc');
    // Past Shows should now start with 5.0 ratings
    const ratings = await page.locator('[class*="text-amber-400"][class*="font-bold"]').allTextContents();
    // Filter to just numeric ratings (exclude "to rate" badge)
    const numericRatings = ratings.filter(r => /^\d/.test(r)).map(r => parseFloat(r));
    // Should be descending
    for (let i = 1; i < numericRatings.length; i++) {
      expect(numericRatings[i]).toBeLessThanOrEqual(numericRatings[i - 1]);
    }
  });

  test('diary "Oldest" sort shows oldest first', async ({ page }) => {
    await goToMock(page);
    await page.getByRole('combobox', { name: 'Sort diary' }).selectOption('date-asc');
    // Book of Mormon (Mar 2024) should appear before Wicked (Dec 2025) in Past Shows
    const cards = await page.locator('h4').allTextContents();
    const mormonIndex = cards.indexOf('The Book of Mormon');
    const wickedIndex = cards.indexOf('Wicked');
    if (mormonIndex >= 0 && wickedIndex >= 0) {
      expect(mormonIndex).toBeLessThan(wickedIndex);
    }
  });

  test('watchlist "A-Z" sort orders alphabetically', async ({ page }) => {
    await goToMock(page, 'watchlist');
    // Switch to list view so titles are easier to extract from card headings
    const listBtn = page.getByRole('button', { name: 'List view' });
    await listBtn.click();
    await expect(listBtn).toHaveClass(/bg-white/, { timeout: 3000 });
    await page.getByRole('combobox', { name: 'Sort watchlist' }).selectOption('alphabetical');
    // Get show title headings from the watchlist cards (h4 inside card items, not the "Add" button)
    const headings = page.locator('[role="tabpanel"] h4');
    const titles = await headings.allTextContents();
    // Filter to actual show titles (min 3 chars, not UI labels)
    const showTitles = titles.filter(t => t.length > 2);
    expect(showTitles.length).toBeGreaterThanOrEqual(5);
    // Should be alphabetical
    const sorted = [...showTitles].sort((a, b) => a.localeCompare(b));
    expect(showTitles).toEqual(sorted);
  });
});

// ─── Tab Switching ─────────────────────────────────────────────

test.describe('My Shows — Tabs', () => {
  test('switching to Watchlist tab shows watchlist content', async ({ page }) => {
    await goToMock(page);
    // Click Watchlist tab
    await page.getByRole('tab', { name: /Watchlist/ }).click();
    // URL should update
    await expect(page).toHaveURL(/tab=watchlist/);
    // Watchlist defaults to grid — check poster images exist (no h4 in grid)
    const posters = page.locator('.aspect-\\[2\\/3\\]');
    expect(await posters.count()).toBeGreaterThanOrEqual(6);
    // Switch to list view and verify titles
    await page.getByRole('button', { name: 'List view' }).click();
    await expect(page.getByRole('heading', { name: 'Gypsy', level: 4 })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Oh, Mary/, level: 4 })).toBeVisible();
  });

  test('switching back to Diary preserves sort', async ({ page }) => {
    await goToMock(page);
    // Change sort to Top Rated
    await page.getByRole('combobox', { name: 'Sort diary' }).selectOption('rating-desc');
    // Switch to Watchlist
    await page.getByRole('tab', { name: /Watchlist/ }).click();
    // Switch back to Diary
    await page.getByRole('tab', { name: 'Diary' }).click();
    // Sort should still be Top Rated
    const sortValue = await page.getByRole('combobox', { name: 'Sort diary' }).inputValue();
    expect(sortValue).toBe('rating-desc');
  });
});

// ─── Grid/List Toggle ──────────────────────────────────────────

test.describe('My Shows — View Toggle', () => {
  test('diary grid view shows poster cards', async ({ page }) => {
    await goToMock(page);
    // Default is list view for diary; switch to grid
    await page.getByRole('button', { name: 'Grid view' }).click();
    // Grid cards have aspect-[2/3] poster areas
    const posters = page.locator('.aspect-\\[2\\/3\\]');
    expect(await posters.count()).toBeGreaterThan(0);
  });

  test('watchlist defaults to grid view', async ({ page }) => {
    await goToMock(page, 'watchlist');
    // Grid button should be active (highlighted)
    const gridBtn = page.getByRole('button', { name: 'Grid view' });
    const classes = await gridBtn.getAttribute('class');
    expect(classes).toContain('bg-white');
  });

  test('trash icons are positioned top-right on grid cards', async ({ page }) => {
    await goToMock(page, 'watchlist');
    // Watchlist grid: trash icons must be in top-right corner of their parent
    const trashButtons = page.locator('button[aria-label="Remove from watchlist"]');
    const count = await trashButtons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const btn = trashButtons.nth(i);
      if (!(await btn.isVisible())) continue;
      const btnBox = await btn.boundingBox();
      const parentBox = await btn.locator('..').boundingBox();
      if (!btnBox || !parentBox) continue;
      // Button should be near the right edge (within 16px of right side)
      const rightOffset = (parentBox.x + parentBox.width) - (btnBox.x + btnBox.width);
      expect(rightOffset, `trash icon ${i} should be near right edge`).toBeLessThan(16);
      // Button should be near the top (within 16px of top)
      const topOffset = btnBox.y - parentBox.y;
      expect(topOffset, `trash icon ${i} should be near top edge`).toBeLessThan(16);
    }
  });

  test('view toggle works independently per tab', async ({ page }) => {
    await goToMock(page);
    // Set diary to grid
    await page.getByRole('button', { name: 'Grid view' }).click();
    // Switch to watchlist (defaults to grid)
    await page.getByRole('tab', { name: /Watchlist/ }).click();
    // Switch watchlist to list
    await page.getByRole('button', { name: 'List view' }).click();
    // Switch back to diary — should still be grid
    await page.getByRole('tab', { name: 'Diary' }).click();
    const gridBtn = page.getByRole('button', { name: 'Grid view' });
    const classes = await gridBtn.getAttribute('class');
    expect(classes).toContain('bg-white');
  });
});

// ─── Delete Confirmation ───────────────────────────────────────

test.describe('My Shows — Delete Flow', () => {
  test('delete shows 2-step confirmation', async ({ page }) => {
    await goToMock(page);
    // Find first delete button
    const deleteBtn = page.getByRole('button', { name: 'Delete rating' }).first();
    await deleteBtn.click();
    // Should show "Delete?" and "No" buttons
    await expect(page.getByRole('button', { name: /Delete\?/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'No' })).toBeVisible();
  });

  test('clicking "No" dismisses confirmation', async ({ page }) => {
    await goToMock(page);
    const deleteBtn = page.getByRole('button', { name: 'Delete rating' }).first();
    await deleteBtn.click();
    await expect(page.getByRole('button', { name: /Delete\?/ })).toBeVisible();
    // Click No
    await page.getByRole('button', { name: 'No' }).click();
    // Confirmation should be gone, trash icon should be back
    await expect(page.getByRole('button', { name: /Delete\?/ })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete rating' }).first()).toBeVisible();
  });

  test('delete confirmation auto-dismisses after timeout', async ({ page }) => {
    await goToMock(page);
    const deleteBtn = page.getByRole('button', { name: 'Delete rating' }).first();
    await deleteBtn.click();
    await expect(page.getByRole('button', { name: /Delete\?/ })).toBeVisible();
    // Wait for auto-dismiss (4 seconds + buffer)
    await page.waitForTimeout(5000);
    await expect(page.getByRole('button', { name: /Delete\?/ })).not.toBeVisible();
  });
});

// ─── Watchlist Tab ─────────────────────────────────────────────

test.describe('My Shows — Watchlist', () => {
  test('shows all 6 watchlist items', async ({ page }) => {
    await goToMock(page, 'watchlist');
    // Grid view: count poster cards (aspect-[2/3] areas, excluding AddShowCard)
    const posters = page.locator('[role="tabpanel"] .aspect-\\[2\\/3\\]');
    expect(await posters.count()).toBeGreaterThanOrEqual(6);
    // Switch to list view to verify titles are present
    await page.getByRole('button', { name: 'List view' }).click();
    const titles = page.locator('[role="tabpanel"] h4');
    expect(await titles.count()).toBeGreaterThanOrEqual(6);
  });

  test('watchlist cards have "Rate" action', async ({ page }) => {
    await goToMock(page, 'watchlist');
    // Grid cards should have Rate overlay
    const rateElements = page.locator('text=Rate');
    expect(await rateElements.count()).toBeGreaterThan(0);
  });

  test('watchlist cards have date picker', async ({ page }) => {
    await goToMock(page, 'watchlist');
    // Date picker buttons (Add date or actual dates)
    const dateButtons = page.locator('text=Add date');
    const existingDates = page.locator('text=Sep 15');
    const totalDates = (await dateButtons.count()) + (await existingDates.count());
    expect(totalDates).toBeGreaterThan(0);
  });

  test('watchlist remove shows confirmation', async ({ page }) => {
    await goToMock(page, 'watchlist');
    // Switch to list view for easier interaction
    await page.getByRole('button', { name: 'List view' }).click();
    const removeBtn = page.getByRole('button', { name: 'Remove from watchlist' }).first();
    await removeBtn.click();
    await expect(page.getByRole('button', { name: /Remove\?/ })).toBeVisible();
  });
});

// ─── Add Show Search ───────────────────────────────────────────

test.describe('My Shows — Add Show', () => {
  test('add button opens search input', async ({ page }) => {
    await goToMock(page);
    const addBtn = page.getByRole('button', { name: /Add a show/ }).first();
    await addBtn.click();
    // Search input should appear
    const input = page.getByPlaceholder(/Search to rate/);
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test('search can be closed with X button', async ({ page }) => {
    await goToMock(page);
    await page.getByRole('button', { name: /Add a show/ }).first().click();
    await expect(page.getByPlaceholder(/Search to rate/)).toBeVisible();
    // Close it
    await page.getByRole('button', { name: 'Close search' }).click();
    await expect(page.getByPlaceholder(/Search to rate/)).not.toBeVisible();
  });
});

// ─── Responsive Layout ─────────────────────────────────────────

test.describe('My Shows — Mobile Layout (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('all sections fit within viewport width', async ({ page }) => {
    await goToMock(page);
    // Check no horizontal overflow
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(390);
  });

  test('To Be Rated stars use xs size on mobile', async ({ page }) => {
    await goToMock(page);
    // On mobile (<640px), the xs StarRating renders with 14px inline style
    // The button has a larger tap target (min 44px) but the visual star is xs
    const starBtn = page.getByRole('button', { name: '1 star' }).first();
    // Check the inline style sets 14px (xs size from SIZE_MAP)
    await expect(starBtn).toHaveAttribute('style', /width:\s*14px/);
    await expect(starBtn).toHaveAttribute('style', /height:\s*14px/);
  });

  test('tab bar does not overflow on mobile', async ({ page }) => {
    await goToMock(page);
    const tablist = page.getByRole('tablist');
    const box = await tablist.boundingBox();
    expect(box).toBeTruthy();
    if (box) {
      expect(box.width).toBeLessThanOrEqual(390);
    }
  });
});

test.describe('My Shows — Desktop Layout (1440px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('diary grid uses 4 columns on desktop', async ({ page }) => {
    await goToMock(page);
    await page.getByRole('button', { name: 'Grid view' }).click();
    // Grid container should have grid-cols-3 sm:grid-cols-4 (resolves to 4 at 1440px)
    const grid = page.locator('.grid.grid-cols-3.sm\\:grid-cols-4');
    await expect(grid.first()).toBeVisible();
  });

  test('diary list shows full star ratings on desktop', async ({ page }) => {
    await goToMock(page);
    // Desktop shows full 5-star display (hidden md:inline-flex)
    const starRatings = page.locator('.hidden.md\\:inline-flex');
    expect(await starRatings.count()).toBeGreaterThan(0);
  });
});

// ─── Visual Regression (screenshots) ───────────────────────────

// Scope snapshots to the My Shows content container, NOT the full page. fullPage
// snapshots captured the shared header/footer too, so any unrelated chrome change
// (e.g. adding a footer nav item) shifted everything and red'd every My Shows
// baseline even when My Shows itself was unchanged — a recurring source of false
// CI reds (test-ugc red 2026-06-04..06). Element-clipping decouples them: only a
// real change inside [data-testid="my-shows-content"] moves these baselines.
test.describe('My Shows — Visual Regression', () => {
  const content = (page: Page) => page.getByTestId('my-shows-content');

  test('diary list view at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goToMock(page);
    await expect(content(page)).toHaveScreenshot('my-shows-diary-list-390.png', {
      animations: 'disabled',
    });
  });

  test('diary grid view at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goToMock(page);
    await page.getByRole('button', { name: 'Grid view' }).click();
    await expect(content(page)).toHaveScreenshot('my-shows-diary-grid-390.png', {
      animations: 'disabled',
    });
  });

  test('watchlist grid view at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goToMock(page, 'watchlist');
    await expect(content(page)).toHaveScreenshot('my-shows-watchlist-grid-390.png', {
      animations: 'disabled',
    });
  });

  test('diary list view at 1440px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goToMock(page);
    await expect(content(page)).toHaveScreenshot('my-shows-diary-list-1440.png', {
      animations: 'disabled',
    });
  });
});
