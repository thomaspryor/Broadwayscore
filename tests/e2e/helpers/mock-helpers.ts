import { type Page } from '@playwright/test';

/**
 * Shared helpers for functional E2E tests using mock mode.
 */

export const VIEWPORTS = [
  { name: 'mobile' as const, width: 390, height: 844 },
  { name: 'desktop' as const, width: 1440, height: 900 },
];

const MOCK_URL = '/my-shows?mock=1';

/**
 * Navigate to My Shows mock page and wait for data to load.
 */
export async function goToMock(
  page: Page,
  tab: 'diary' | 'watchlist' = 'diary'
): Promise<void> {
  await page.goto(`${MOCK_URL}&tab=${tab}`);
  // The tablist renders once mock data is loaded (the old "shows seen" summary
  // text was removed 2026-07-12 — counts live in the tab badges now).
  await page.waitForSelector('[role="tablist"]', { timeout: 30000 });
  await page.waitForSelector('#tab-watchlist span', { timeout: 30000 });
}

/**
 * Switch the current My Shows tab to LIST view. The diary/watchlist default
 * became GRID (2026-07-17), so specs asserting list-row UI (h4 titles, edit
 * links, Delete?/No confirm buttons) must opt in explicitly.
 */
export async function switchToListView(page: Page): Promise<void> {
  const toggle = page.locator('button[aria-label="List view"]:visible').first();
  await toggle.click();
  await page.waitForTimeout(250);
}

/**
 * Navigate to the rating-editor fixture page (the live shared editor).
 * @param query - e.g. '' | '?state=edit' | '?presentation=modal&stack=1'
 */
export async function goToRatingEditor(page: Page, query = ''): Promise<void> {
  await page.goto(`/test/rating-editor-fixture${query}`);
  await page.waitForSelector('[data-testid="rating-editor"]', { timeout: 30000 });
}
