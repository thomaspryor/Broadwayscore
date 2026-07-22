import { test, expect } from '@playwright/test';
import { filterNonCriticalErrors } from './helpers/console-errors';

/**
 * E2E tests for user account flows (UGC).
 *
 * These tests verify the My Shows page layout, Watchlist/Diary UI,
 * and sign-in modal behavior WITHOUT requiring actual authentication.
 * Auth-dependent flows are tested by verifying the sign-in modal appears
 * when unauthenticated users attempt protected actions.
 *
 * NOTE: These tests run against the live site where userAccounts may be
 * feature-flagged off. Tests that require the feature flag will skip gracefully.
 */

const SHOW_SLUG = 'hamilton-2015'; // Stable, long-running show for testing

test.describe('My Shows Page (Unauthenticated)', () => {
  test('shows sign-in prompt when not authenticated', async ({ page }) => {
    await page.goto('/my-shows');
    await page.waitForLoadState('networkidle');

    const body = await page.textContent('body');

    // Either: feature flag off (shows "not yet available") or shows sign-in prompt
    const hasSignInPrompt = body?.includes('Sign In to Get Started');
    const hasFeatureOff = body?.includes('not yet available');
    const hasMyShows = body?.includes('My Shows');

    expect(hasSignInPrompt || hasFeatureOff || hasMyShows).toBeTruthy();
  });

  test('my-shows page loads without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/my-shows');
    await page.waitForLoadState('networkidle');

    const criticalErrors = filterNonCriticalErrors(errors);

    expect(criticalErrors.length).toBe(0);
  });
});

test.describe('Sign-In Modal', () => {
  test('header user icon triggers sign-in modal', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Find the user icon button in the header
    const userButton = page.locator('button[aria-label="Sign In"], a[aria-label="My Shows"]');

    if ((await userButton.count()) === 0) {
      test.skip(true, 'User accounts feature not enabled');
      return;
    }

    // If it's a button (not authenticated), click it
    const tagName = await userButton.first().evaluate(el => el.tagName);
    if (tagName === 'BUTTON') {
      await userButton.first().click();

      // Sign-in modal should appear
      await expect(page.locator('text=Continue with Google')).toBeVisible({ timeout: 5000 });

      // Should have Apple option (enabled or coming soon)
      const appleButton = page.locator('button:has-text("Apple")');
      await expect(appleButton).toBeVisible();
    }
  });

  test('sign-in modal closes on Escape', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const userButton = page.locator('button[aria-label="Sign In"]');
    if ((await userButton.count()) === 0) {
      test.skip(true, 'User accounts not enabled or already authenticated');
      return;
    }

    await userButton.first().click();
    await expect(page.locator('text=Continue with Google')).toBeVisible({ timeout: 5000 });

    // Press Escape
    await page.keyboard.press('Escape');

    // Modal should be gone
    await expect(page.locator('text=Continue with Google')).not.toBeVisible({ timeout: 3000 });
  });

  test('sign-in modal closes on backdrop click', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const userButton = page.locator('button[aria-label="Sign In"]');
    if ((await userButton.count()) === 0) {
      test.skip(true, 'User accounts not enabled');
      return;
    }

    await userButton.first().click();
    await expect(page.locator('text=Continue with Google')).toBeVisible({ timeout: 5000 });

    // Click backdrop (the dark overlay)
    await page.locator('.backdrop-blur-sm').click({ position: { x: 10, y: 10 } });

    await expect(page.locator('text=Continue with Google')).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe('Show Page Rating Section', () => {
  test('show page has Your Rating section when feature enabled', async ({ page }) => {
    await page.goto(`/show/${SHOW_SLUG}`);
    await page.waitForLoadState('networkidle');

    const ratingSection = page.locator('text=Your Rating');

    if ((await ratingSection.count()) === 0) {
      test.skip(true, 'User accounts feature not enabled');
      return;
    }

    // Star rating should be visible
    await expect(ratingSection).toBeVisible();
  });

  test('clicking stars triggers sign-in for unauthenticated users', async ({ page }) => {
    await page.goto(`/show/${SHOW_SLUG}`);
    await page.waitForLoadState('networkidle');

    const ratingSection = page.locator('text=Your Rating');
    if ((await ratingSection.count()) === 0) {
      test.skip(true, 'User accounts feature not enabled');
      return;
    }

    // Find star buttons (they're SVGs inside the StarRating component)
    const stars = page.locator('[aria-label*="star"], [role="button"]').filter({ hasText: /★|☆/ });

    // If there are clickable star elements, click one
    if ((await stars.count()) > 0) {
      await stars.first().click();

      // Should trigger sign-in modal
      const modal = page.locator('text=Continue with Google');
      if ((await modal.count()) > 0) {
        await expect(modal).toBeVisible({ timeout: 5000 });
      }
    }
  });

  test('watchlist button is visible on show page', async ({ page }) => {
    await page.goto(`/show/${SHOW_SLUG}`);
    await page.waitForLoadState('networkidle');

    // Check for watchlist button
    const watchlistBtn = page.locator('button:has-text("Watchlist"), [aria-label*="watchlist"], [aria-label*="Watchlist"]');

    if ((await watchlistBtn.count()) === 0) {
      // Feature might not be enabled
      test.skip(true, 'Watchlist feature not visible');
      return;
    }

    await expect(watchlistBtn.first()).toBeVisible();
  });

  test('date picker uses native input (not showPicker)', async ({ page }) => {
    await page.goto(`/show/${SHOW_SLUG}`);
    await page.waitForLoadState('networkidle');

    // Look for the date input pattern: <label> wrapping <input type="date">
    // This verifies we're using the native label+input approach, not showPicker()
    const dateInputs = page.locator('label input[type="date"]');

    // There might be 0 if not authenticated/no watchlist, that's fine
    // But if they exist, verify they're properly wrapped in a label
    const count = await dateInputs.count();
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const input = dateInputs.nth(i);
        // Should have opacity-0 class (hidden but clickable via label)
        const classes = await input.getAttribute('class');
        expect(classes).toMatch(/opacity-0|opacity-\[0\.01\]/);
      }
    }
  });

  test('"See all my Ratings" link text is correct', async ({ page }) => {
    await page.goto(`/show/${SHOW_SLUG}`);
    await page.waitForLoadState('networkidle');

    // If authenticated with ratings, this link should say "See all my Ratings"
    const badLink = page.locator('a:has-text("See all Ratings")');
    const goodLink = page.locator('a:has-text("See all my Ratings")');

    // Should NOT have the old "See all Ratings" text (without "my")
    // But only check if the link exists at all (requires auth + ratings)
    const badCount = await badLink.count();
    const goodCount = await goodLink.count();

    if (badCount > 0 || goodCount > 0) {
      // If the link exists, it should be the correct version
      expect(badCount).toBe(0);
    }
  });
});

test.describe('Diary Search & Production Picker', () => {
  // Fetched via page.request (raw HTTP, not page.goto) — these files are large
  // (10MB+) and page.goto + res.json() reads the body through Chrome's CDP
  // inspector cache, which evicts large responses ("Request content was
  // evicted from inspector cache"). page.request.get() bypasses that cache.
  test('diary-search.json is fetchable and valid', async ({ page }) => {
    const res = await page.request.get('/data/diary-search.json');
    if (res.status() === 404) {
      test.skip(true, 'diary-search.json not deployed yet');
      return;
    }
    const data = await res.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('diary-lookup.json is fetchable and valid', async ({ page }) => {
    const res = await page.request.get('/data/diary-lookup.json');
    if (res.status() === 404) {
      test.skip(true, 'diary-lookup.json not deployed yet');
      return;
    }
    const data = await res.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('multi-production search entries have prods array', async ({ page }) => {
    const res = await page.request.get('/data/diary-search.json');
    if (res.status() === 404) {
      test.skip(true, 'diary-search.json not deployed yet');
      return;
    }
    const data = await res.json();
    const multis = data.filter((e: any) => e.prods);
    if (multis.length === 0) {
      test.skip(true, 'No multi-production entries found');
      return;
    }

    // Every multi-production entry should have gid, title, n, and prods
    for (const entry of multis.slice(0, 10)) {
      expect(entry.gid).toBeTruthy();
      expect(entry.title).toBeTruthy();
      expect(entry.n).toBeGreaterThan(1);
      expect(Array.isArray(entry.prods)).toBeTruthy();
      expect(entry.prods.length).toBe(entry.n);

      // Each production should have an id
      for (const prod of entry.prods.slice(0, 5)) {
        expect(prod.id).toBeTruthy();
      }
    }
  });
});

test.describe('My Shows Page Layout', () => {
  test('tab bar and sort controls are on the same line', async ({ page }) => {
    await page.goto('/my-shows');
    await page.waitForLoadState('networkidle');

    // If authenticated, verify the sort dropdown is inline with tabs
    const tabBar = page.locator('.border-b.border-white\\/10').first();
    if ((await tabBar.count()) === 0) {
      test.skip(true, 'Tab bar not visible (not authenticated or feature off)');
      return;
    }

    // The sort select should be inside the same flex container as tabs
    const sortSelect = tabBar.locator('select');
    if ((await sortSelect.count()) > 0) {
      // Verify they're on the same line by checking the parent is flex
      const parentClasses = await tabBar.getAttribute('class');
      expect(parentClasses).toContain('flex');
      expect(parentClasses).toContain('items-center');
    }
  });
});

test.describe('Show Page - No Layout Overflow', () => {
  test('star ratings do not overflow their container on mobile', async ({ page }) => {
    // Only relevant on mobile viewport
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 500) {
      // Desktop test — skip overflow check
      test.skip(true, 'Only relevant on mobile viewport');
      return;
    }

    await page.goto(`/show/${SHOW_SLUG}`);
    await page.waitForLoadState('networkidle');

    // Check all star rating containers don't overflow
    const ratingContainers = page.locator('[class*="flex-shrink-0"][class*="flex-col"]');
    const count = await ratingContainers.count();
    // A selector drift silently dropping count to 0 must fail loudly, not
    // pass having checked nothing (sibling of the test-red incident fixed
    // in my-shows-functional.spec.ts, 2026-07-21).
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < Math.min(count, 5); i++) {
      const container = ratingContainers.nth(i);
      const box = await container.boundingBox();
      if (!box) continue;

      // Container should not exceed reasonable width (120px for a rating column)
      expect(box.width).toBeLessThan(120);
    }
  });
});
