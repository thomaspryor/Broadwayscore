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
  await page.waitForSelector('text=shows seen', { timeout: 10000 });
}

/**
 * Navigate to the show-rating fixture page.
 * @param state - 'existing' | 'empty' | 'multi'
 */
export async function goToShowFixture(
  page: Page,
  state: 'existing' | 'empty' | 'multi' = 'existing'
): Promise<void> {
  await page.goto(`/test/show-rating-fixture?state=${state}`);
  await page.waitForSelector('[data-testid="show-rating-fixture"]', { timeout: 10000 });
}
