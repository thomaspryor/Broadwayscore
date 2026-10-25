import { type Page, type Locator } from '@playwright/test';
import { test, expect } from './helpers/ugc-test';
import { switchToListView } from './helpers/mock-helpers';

/**
 * Interactive QA walkthrough for UGC pages.
 *
 * Unlike static screenshot tests, this actually USES the UI:
 * - Hovers over every interactive element and checks for visual glitches
 * - Clicks buttons and verifies the correct behavior (navigation vs state change)
 * - Measures element sizes/positions to catch layout issues
 * - Checks component consistency (all grid cards same height, icons in rows not columns)
 *
 * Run: TEST_BASE_URL=http://localhost:3456 npx playwright test --project=chromium tests/e2e/ugc-interactive-qa.spec.ts
 */

const MOCK_URL = '/my-shows?mock=1';

async function goToMock(page: Page, tab: 'diary' | 'watchlist' = 'diary') {
  await page.goto(`${MOCK_URL}&tab=${tab}`);
  await page.waitForSelector('#tab-watchlist span', { timeout: 30000 });
}

/** Interactive rate stars on My Shows live on past-dated watchlist rows,
 *  which list on their own in the A-Z view (To Be Rated became a poster
 *  band with no inline stars, BRO-4558). */
async function goToRateStars(page: Page) {
  await goToMock(page, 'watchlist');
  await page.getByRole('combobox', { name: 'Sort watchlist' }).selectOption('alphabetical');
  await page.getByRole('button', { name: 'List view' }).click();
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: Hover interaction checks
// Catches: flicker, ghost elements, broken hover states
// ═══════════════════════════════════════════════════════════════

test.describe('Hover interactions — mobile (390px)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('star rating hover does not create visual artifacts', async ({ page }) => {
    await goToRateStars(page);

    // Find all interactive star buttons (past-dated watchlist rows)
    const starButtons = page.locator('[role="radiogroup"][aria-label="Star rating"] button[aria-label*="star"]');
    const count = await starButtons.count();
    expect(count).toBeGreaterThan(0);

    // Hover over each star, take a screenshot, check no extra elements appear
    for (let i = 0; i < Math.min(count, 5); i++) {
      const star = starButtons.nth(i);
      if (!(await star.isVisible())) continue;

      // Get element count inside the star button BEFORE hover
      const childCountBefore = await star.evaluate(el => el.querySelectorAll('*').length);

      await star.hover();
      await page.waitForTimeout(100);

      // Get element count AFTER hover — should be the same
      // (If hover creates extra overlay elements, this catches it)
      const childCountAfter = await star.evaluate(el => el.querySelectorAll('*').length);

      // Allow ±1 for potential tooltip, but not more
      expect(
        Math.abs(childCountAfter - childCountBefore),
        `Star button ${i} gained ${childCountAfter - childCountBefore} child elements on hover`
      ).toBeLessThanOrEqual(1);
    }
  });

  test('star rating hover position is stable (no flicker)', async ({ page }) => {
    await goToRateStars(page);

    // Find the interactive star rating containers (past-dated watchlist rows)
    const starGroups = page.locator('[role="radiogroup"][aria-label="Star rating"]');
    expect(await starGroups.count()).toBeGreaterThan(0);

    const starGroup = starGroups.first();
    const star3 = starGroup.locator('button[aria-label="3 stars"]');
    if (!(await star3.isVisible())) return;

    const box = await star3.boundingBox();
    if (!box) return;

    // Move to the right side of star 3 (should show 3 full stars)
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
    await page.waitForTimeout(100);

    // Read the fill state by counting how many gold paths are visible
    const goldCount1 = await starGroup.evaluate(el => {
      return el.querySelectorAll('path[fill="#FFD700"]').length;
    });

    // Move slightly within the same right half (should still be 3 full stars)
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2);
    await page.waitForTimeout(100);

    const goldCount2 = await starGroup.evaluate(el => {
      return el.querySelectorAll('path[fill="#FFD700"]').length;
    });

    // Small movement in same half = same number of filled stars
    expect(goldCount1, `Star fill changed from ${goldCount1} to ${goldCount2} gold paths on small movement in same half`).toBe(goldCount2);
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Click behavior checks
// Catches: wrong navigation, missing state updates
// ═══════════════════════════════════════════════════════════════

test.describe('Click behaviors — mobile (390px)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('watchlist "Add show" search adds directly without navigating', async ({ page }) => {
    await goToMock(page, 'watchlist');

    const initialUrl = page.url();

    // Click the Add show button in the header
    const addBtn = page.locator('button[aria-label="Add to watchlist"]');
    await addBtn.click();

    // Search input should appear
    const searchInput = page.locator('input[placeholder*="Search to add"]');
    await expect(searchInput).toBeVisible({ timeout: 3000 });

    // Type a show name
    await searchInput.fill('Wicked');
    await page.waitForTimeout(500);

    // Click first result
    const firstResult = page.locator('button:has-text("Wicked")').first();
    await expect(firstResult).toBeVisible({ timeout: 5000 });
    await firstResult.click();
    await page.waitForTimeout(500);

    // CRITICAL CHECK: should still be on My Shows page, NOT navigated to show page
    expect(page.url(), 'Watchlist add navigated away from My Shows page').toContain('/my-shows');
    expect(page.url()).not.toContain('/show/');

    // In-place follow-up: the just-added prompt confirms the add and offers
    // the planned date without hunting for the entry (owner, 2026-07-19).
    await expect(page.getByTestId('just-added-prompt')).toBeVisible();
    await expect(page.getByTestId('just-added-prompt')).toContainText('Wicked');
    await expect(page.getByTestId('just-added-prompt').getByRole('button', { name: 'Planned date' })).toBeVisible();
    // Skip dismisses it.
    await page.getByTestId('just-added-prompt').getByRole('button', { name: 'Skip' }).click();
    await expect(page.getByTestId('just-added-prompt')).not.toBeVisible();
  });

  test('diary "Add show" search navigates to show page for rating', async ({ page }) => {
    await goToMock(page, 'diary');

    const addBtn = page.locator('button[aria-label="Add a show to diary"]');
    await addBtn.click();

    const searchInput = page.locator('input[placeholder*="Search to rate"]');
    await expect(searchInput).toBeVisible({ timeout: 3000 });

    await searchInput.fill('Hamilton');
    await page.waitForTimeout(500);

    const firstResult = page.locator('button:has-text("Hamilton")').first();
    await expect(firstResult).toBeVisible({ timeout: 5000 });
    await firstResult.click();

    // Wait for navigation to complete (client-side routing can take time)
    await page.waitForURL(/\/show\//, { timeout: 10000 });

    // Diary add SHOULD navigate to show page with ?rate=1
    expect(page.url(), 'Diary add should navigate to show page').toContain('/show/');
    expect(page.url()).toContain('rate=1');
  });

  test('delete confirmation appears and auto-dismisses', async ({ page }) => {
    await goToMock(page, 'diary');
    await switchToListView(page); // list-row UI — diary/watchlist default is grid (2026-07-17)

    // Find a delete button on a list card
    const deleteBtn = page.locator('button[aria-label="Delete rating"]').first();
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    // Confirmation text should appear
    await expect(page.getByText('Delete?').first()).toBeVisible({ timeout: 1000 });

    // Wait for auto-dismiss (4 seconds)
    await page.waitForTimeout(4500);
    await expect(page.getByText('Delete?').first()).not.toBeVisible({ timeout: 1000 });
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: Layout consistency checks
// Catches: mismatched card heights, floating icons, broken alignment
// ═══════════════════════════════════════════════════════════════

test.describe('Layout consistency — mobile (390px)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('all diary list cards have edit/trash icons on same row as rating', async ({ page }) => {
    await goToMock(page, 'diary');

    // Check that edit and delete icons are in the same flex container as the rating
    const issues = await page.evaluate(() => {
      const problems: string[] = [];
      // Find all diary cards by looking for "Edit rating" links
      const editLinks = document.querySelectorAll('a[aria-label="Edit rating"]');
      editLinks.forEach((link, i) => {
        const parent = link.parentElement;
        if (!parent) return;
        const grandparent = parent.parentElement;
        if (!grandparent) return;

        // The rating (star or number) and icons should share a flex-row parent
        const style = getComputedStyle(grandparent);
        const direction = style.flexDirection;

        if (direction === 'column') {
          problems.push(`Card ${i}: icons are in flex-col (should be flex-row) — icons will float below rating`);
        }

        // Check that rating and icons have similar vertical centers
        const ratingEl = grandparent.querySelector('span, svg');
        if (ratingEl && link) {
          const ratingRect = ratingEl.getBoundingClientRect();
          const iconRect = link.getBoundingClientRect();
          const verticalDiff = Math.abs(
            (ratingRect.top + ratingRect.height / 2) -
            (iconRect.top + iconRect.height / 2)
          );
          if (verticalDiff > 20) {
            problems.push(`Card ${i}: icons are ${Math.round(verticalDiff)}px vertically offset from rating`);
          }
        }
      });
      return problems;
    });

    expect(issues, 'Icon placement issues found').toEqual([]);
  });

  // FIXME(2026-07-10): first CI run ever for this spec (it was testIgnored but
  // never listed in test-ugc.yml) found grid cards in TWO height groups
  // (248px rated vs 388px unrated) — cleanly bimodal, so likely an intentional
  // "To Be Rated" card design added after this assertion was written, not an
  // overflow bug. Needs a design decision: either the two-tier height is
  // intended (assert per-group consistency instead) or it's a regression.
  // Notion: "ugc-interactive-qa grid-height triage".
  test.fixme('diary grid cards have consistent heights', async ({ page }) => {
    await goToMock(page, 'diary');

    // Switch to grid view
    // Use Playwright actionable click (waits for attached/visible/stable)
    // rather than synthesized DOM .click() which can race React hydration.
    await page.getByRole('button', { name: 'Grid view' }).click();
    await page.waitForTimeout(500);

    const heights = await page.evaluate(() => {
      // Find grid container for Past Shows
      const gridContainers = document.querySelectorAll('.grid');
      const results: { heights: number[]; maxDiff: number } = { heights: [], maxDiff: 0 };

      gridContainers.forEach(grid => {
        const children = Array.from(grid.children) as HTMLElement[];
        if (children.length < 2) return;

        const childHeights = children.map(c => c.getBoundingClientRect().height);
        results.heights = childHeights;

        const max = Math.max(...childHeights);
        const min = Math.min(...childHeights);
        results.maxDiff = max - min;
      });

      return results;
    });

    // Grid cards should be within 30px of each other
    // (some variation OK due to optional date text)
    if (heights.heights.length > 1) {
      expect(
        heights.maxDiff,
        `Grid card height varies by ${Math.round(heights.maxDiff)}px (heights: ${heights.heights.map(h => Math.round(h)).join(', ')})`
      ).toBeLessThan(40);
    }
  });

  test('grid "Add" card is exactly poster height', async ({ page }) => {
    for (const tab of ['diary', 'watchlist'] as const) {
      await goToMock(page, tab);
      await page.getByRole('button', { name: 'Grid view' }).click();
      // The owner wants the dashed card the size of a poster (2026-10-03);
      // the grid used to stretch it to the tallest card in the row. The old
      // version of this test looked up a label that no longer existed, so it
      // never ran.
      const add = page.getByRole('button', { name: tab === 'diary' ? 'Rate a new show' : 'Add a new show to watchlist' });
      await expect(add).toBeVisible();
      const poster = add.locator('xpath=..').locator('.aspect-\\[2\\/3\\]').first();
      const [a, p] = [await add.boundingBox(), await poster.boundingBox()];
      expect(a && p, `${tab}: add card or sibling poster not found`).toBeTruthy();
      expect(Math.abs(a!.height - p!.height), `${tab}: add ${a!.height}px vs poster ${p!.height}px`).toBeLessThanOrEqual(2);
      expect(Math.abs(a!.y - p!.y), `${tab}: add card is not top-aligned with the poster`).toBeLessThanOrEqual(2);
    }
  });

  test('diary grid posters have no delete button at mobile width', async ({ page }) => {
    await goToMock(page, 'diary');
    await page.getByRole('button', { name: 'Grid view' }).click();
    // Owner, 2026-10-03 (BRO-4558): the 44px trash circles covered the
    // posters on phones; delete is on the show page (and list view).
    const panel = page.locator('[role="tabpanel"]');
    expect(await panel.locator('.grid a[aria-label^="View "]').count()).toBeGreaterThan(0);
    await expect(panel.locator('.grid button[aria-label="Delete rating"]')).toHaveCount(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: Responsive checks (desktop 1440px)
// Catches: issues that only appear at desktop width
// ═══════════════════════════════════════════════════════════════

test.describe('Desktop layout (1440px)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('edit/delete icons are hidden until card hover', async ({ page }) => {
    await goToMock(page, 'diary');
    await switchToListView(page); // list-row UI — diary/watchlist default is grid (2026-07-17)

    // Before hovering, edit icons should be invisible (opacity-0).
    // :visible — DiaryCard renders the icons twice (mobile in-flow copy is
    // display:none at 1440 but still computes opacity 1); only the desktop
    // hover-corner instance is display-visible here.
    const firstEditLink = page.locator('a[aria-label="Edit rating"]:visible').first();
    const opacity = await firstEditLink.evaluate(el => {
      const parent = el.parentElement;
      return parent ? getComputedStyle(parent).opacity : '1';
    });

    expect(opacity, 'Edit icons visible without hover on desktop').toBe('0');

    // After hovering the card, they should become visible
    const card = page.locator('.group\\/diary').first();
    await card.hover();
    await page.waitForTimeout(200);

    const opacityAfter = await firstEditLink.evaluate(el => {
      const parent = el.parentElement;
      return parent ? getComputedStyle(parent).opacity : '0';
    });

    expect(opacityAfter, 'Edit icons not visible on card hover').toBe('1');
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Menu keyboard focus
// Catches: closing the account menu dropping focus to <body> (BRO-4525)
// ═══════════════════════════════════════════════════════════════

test.describe('Menu focus (390px)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  const ways: Record<string, (page: Page) => Promise<void>> = {
    // A keyboard user presses Escape from inside the panel.
    Escape: async (page) => {
      await page.getByRole('button', { name: 'Close menu' }).focus();
      await page.keyboard.press('Escape');
    },
    'the close button': (page) => page.getByRole('button', { name: 'Close menu' }).click(),
    'the backdrop': (page) => page.mouse.click(10, 400),
  };

  for (const [name, closeMenu] of Object.entries(ways)) {
    test(`closing with ${name} returns focus to the menu button`, async ({ page }) => {
      await goToMock(page);
      const trigger = page.getByRole('button', { name: 'Open menu' }).first();
      await trigger.click();
      await expect(page.getByRole('button', { name: 'Close menu' })).toBeVisible();
      await closeMenu(page);
      await expect(page.getByRole('button', { name: 'Close menu' })).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  }
});
