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
  // data-ready flips once mock data is loaded (the tab count badges that used
  // to signal this were removed with the title-tab header, BRO-6170).
  await page.waitForSelector('[data-testid="my-shows-content"][data-ready="true"]', { timeout: 30000 });
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

/**
 * Element screenshots scroll their target to the top of the viewport, where
 * the site's fixed header (layout.tsx, `header.fixed`) covers its first ~64px.
 * That hid the old "My Shows" heading and, since BRO-6170, hid the whole
 * Diary / Watchlist / Lists title row from every My Shows baseline. Pinning
 * the header to the top of the document instead keeps it out of the clip.
 * Call before navigating; it applies to every page load in the test.
 */
export async function unstickSiteHeader(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const css = 'body header.fixed { position: absolute !important; }';
    const add = () => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
    else add();
  });
}

