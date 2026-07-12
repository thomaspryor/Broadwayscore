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
  // "shows seen" text is always visible in the summary bar regardless of active tab
  await page.waitForSelector('text=shows seen', { timeout: 30000 });
}

/**
 * Navigate to the rating-editor fixture page (the live shared editor).
 * @param query - e.g. '' | '?state=edit' | '?presentation=modal&stack=1'
 */
export async function goToRatingEditor(page: Page, query = ''): Promise<void> {
  await page.goto(`/test/rating-editor-fixture${query}`);
  await page.waitForSelector('[data-testid="rating-editor"]', { timeout: 30000 });
}
