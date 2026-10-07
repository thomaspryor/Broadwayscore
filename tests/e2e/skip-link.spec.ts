import { test, expect } from '@playwright/test';

/**
 * Regression test for the "Skip to main content" DEAD CONTROL (card #325,
 * ux-walkthrough dead-control detector on mobile__diary_grid, 2026-07-27).
 *
 * The bug: the anchor pointed at #main-content, but <main> carried no tabIndex,
 * so activating the link moved neither focus nor (on a short page, because the
 * landmark sat under the 64px fixed header) the scroll position. The detector
 * correctly reported "no visible change on click".
 *
 * The contract this pins is the canonical accessible skip-link pattern: after
 * activating the link, focus must be ON the <main> landmark. That holds
 * regardless of page height, which is why it is the assertion rather than the
 * scroll offset.
 */
test.describe('Skip to main content', () => {
  test('moves focus to the <main> landmark when activated', async ({ page }) => {
    await page.goto('/');

    const skipLink = page.locator('a[href="#main-content"]');
    await expect(skipLink).toHaveCount(1);

    // Focus the link explicitly rather than pressing Tab: mobile WebKit (iOS
    // Safari) does not move focus between links on Tab by default, so a
    // Tab-driven test would assert a browser preference, not our contract.
    // What we actually promise is that ACTIVATING the link moves focus.
    await skipLink.focus();
    await expect(skipLink).toBeFocused();

    await page.keyboard.press('Enter');

    // Focus must land on the landmark itself — this is what was broken.
    const focusedId = await page.evaluate(() => document.activeElement?.id ?? '');
    expect(focusedId).toBe('main-content');
  });

  test('<main> is focusable and clears the fixed header', async ({ page }) => {
    await page.goto('/');

    const main = page.locator('main#main-content');
    await expect(main).toHaveAttribute('tabindex', '-1');

    // scroll-mt-16 == scroll-margin-top: 4rem, matching the h-16 fixed header.
    // Without it the landmark scrolls to underneath the header.
    const scrollMarginTop = await main.evaluate(
      (el) => getComputedStyle(el).scrollMarginTop
    );
    expect(scrollMarginTop).toBe('64px');
  });
});
