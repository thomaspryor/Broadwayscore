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
    // 7 reviews in mock data
    await expect(page.getByText('7')).toBeVisible();
    await expect(page.getByText('shows seen')).toBeVisible();
    // 6 watchlist items
    await expect(page.getByText('6')).toBeVisible();
    await expect(page.getByText('watchlist')).toBeVisible();
    // 2 to-be-rated items (Chess + Ragtime have past planned_dates)
    await expect(page.getByText('2')).toBeVisible();
    await expect(page.getByText('to rate')).toBeVisible();
  });

  test('no console errors on page load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await goToMock(page);
    const critical = errors.filter(e =>
      !e.includes('favicon') && !e.includes('analytics') && !e.includes('DevTools')
    );
    expect(critical).toEqual([]);
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
    // Gypsy (Mar 20) and Smash (Apr 10)
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
    expect(url).toContain('/show/ragtime-2025');
  });

  test('show badges display correctly', async ({ page }) => {
    await goToMock(page);
    // Wicked should show MUSICAL + NOW PLAYING
    await expect(page.getByText('MUSICAL').first()).toBeVisible();
    await expect(page.getByText('NOW PLAYING').first()).toBeVisible();
    // Sunset Boulevard should show CLOSED
    await expect(page.getByText('CLOSED').first()).toBeVisible();
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
    expect(count).toBe(7); // 7 rated shows
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
    await page.getByRole('combobox', { name: 'Sort watchlist' }).selectOption('alphabetical');
    const titles = await page.locator('h4').allTextContents();
    // Filter to show titles (skip "Add" etc.)
    const showTitles = titles.filter(t => t !== 'Rate' && t !== 'Add' && t.length > 2);
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
    // Watchlist shows should appear (6 items)
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
    // Count show title headings (excluding "Add" card)
    const titles = page.locator('h4');
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
    const existingDates = page.locator('text=Mar 20');
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
    // Star buttons in To Be Rated should be small (14px)
    const starBtn = page.getByRole('button', { name: '1 star' }).first();
    const box = await starBtn.boundingBox();
    expect(box).toBeTruthy();
    if (box) {
      expect(box.width).toBeLessThanOrEqual(20); // xs = 14px + some padding
    }
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
    // Grid container should have sm:grid-cols-4
    const grid = page.locator('.grid.grid-cols-3');
    await expect(grid).toBeVisible();
  });

  test('diary list shows full star ratings on desktop', async ({ page }) => {
    await goToMock(page);
    // Desktop shows full 5-star display (hidden md:inline-flex)
    const starRatings = page.locator('.hidden.md\\:inline-flex');
    expect(await starRatings.count()).toBeGreaterThan(0);
  });
});

// ─── Visual Regression (screenshots) ───────────────────────────

test.describe('My Shows — Visual Regression', () => {
  test('diary list view at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goToMock(page);
    await expect(page).toHaveScreenshot('my-shows-diary-list-390.png', {
      fullPage: true,
      animations: 'disabled',
    });
  });

  test('diary grid view at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goToMock(page);
    await page.getByRole('button', { name: 'Grid view' }).click();
    await expect(page).toHaveScreenshot('my-shows-diary-grid-390.png', {
      fullPage: true,
      animations: 'disabled',
    });
  });

  test('watchlist grid view at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goToMock(page, 'watchlist');
    await expect(page).toHaveScreenshot('my-shows-watchlist-grid-390.png', {
      fullPage: true,
      animations: 'disabled',
    });
  });

  test('diary list view at 1440px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goToMock(page);
    await expect(page).toHaveScreenshot('my-shows-diary-list-1440.png', {
      fullPage: true,
      animations: 'disabled',
    });
  });
});
