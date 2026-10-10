import { test, expect, type Page } from '@playwright/test';
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
const SECOND_SHOW_SLUG = 'wicked-2003';

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

const signInDialog = (page: Page) => page.getByRole('dialog', { name: 'Sign in' });

/**
 * Opens the sign-in modal the way a signed-out visitor would: the header pill
 * on desktop, the hamburger menu on phones (the header pill is hidden below
 * `sm`). Role queries match the accessible name case-insensitively, so copy
 * casing ("Sign in" in the header, "Sign In" in the menu) can't turn these
 * into silent skips again: the old `button[aria-label="Sign In"]` selector
 * never matched the real "Sign in" button, so every run skipped.
 * Returns false when accounts are not live on this host.
 */
async function openSignInModal(page: Page): Promise<boolean> {
  // Phones: the menu's My Shows card says "Sign in · free" (BRO-4616).
  const signIn = page.getByRole('button', { name: /^sign in( · free| to keep them)?$/i });
  if ((await signIn.count()) === 0) {
    const menu = page.getByRole('button', { name: 'Open menu' });
    if ((await menu.count()) === 0) return false;
    await menu.first().click();
  }
  if ((await signIn.count()) === 0) return false;
  await signIn.first().click();
  await expect(signInDialog(page)).toBeVisible({ timeout: 5000 });
  return true;
}

test.describe('Sign-In Modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('header or menu Sign in opens the modal with Google and Apple', async ({ page }) => {
    if (!(await openSignInModal(page))) {
      test.skip(true, 'User accounts feature not enabled');
      return;
    }
    const dialog = signInDialog(page);
    await expect(dialog.getByRole('button', { name: /continue with google/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /apple/i })).toBeVisible();
  });

  test('sign-in modal closes on Escape', async ({ page }) => {
    if (!(await openSignInModal(page))) {
      test.skip(true, 'User accounts feature not enabled');
      return;
    }
    await page.keyboard.press('Escape');
    await expect(signInDialog(page)).toBeHidden({ timeout: 3000 });
  });

  test('sign-in modal closes on backdrop click', async ({ page }) => {
    if (!(await openSignInModal(page))) {
      test.skip(true, 'User accounts feature not enabled');
      return;
    }
    // Scoped to the dialog: the homepage explainer pill also carries
    // .backdrop-blur-sm, so a bare class selector trips strict mode.
    await signInDialog(page).locator('.backdrop-blur-sm').click({ position: { x: 10, y: 10 } });
    await expect(signInDialog(page)).toBeHidden({ timeout: 3000 });
  });
});

test.describe('Show Page Rating Section', () => {
  // Save first, ask right after (BRO-4616): the tap saves without an account,
  // then the sign-in sheet opens; closing it keeps the save.
  test('Want to See saves for a signed-out visitor, then asks them to sign in', async ({ page }) => {
    await page.goto(`/show/${SHOW_SLUG}`);
    await page.waitForLoadState('networkidle');

    const wantToSee = page.getByRole('button', { name: /want to see/i });
    if ((await wantToSee.count()) === 0) {
      test.skip(true, 'User accounts feature not enabled');
      return;
    }
    await wantToSee.first().click();
    await expect(signInDialog(page)).toBeVisible({ timeout: 5000 });
    await expect(signInDialog(page).getByText('Keep your list with a free account')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(signInDialog(page)).toBeHidden({ timeout: 3000 });
    await expect(page.getByRole('button', { name: /on your list/i }).first()).toBeVisible({ timeout: 5000 });

    // Within the cooldown, another save does not ask again.
    await page.goto(`/show/${SECOND_SHOW_SLUG}`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /want to see/i }).first().click();
    await expect(page.getByRole('button', { name: /on your list/i }).first()).toBeVisible({ timeout: 5000 });
    await expect(signInDialog(page)).toBeHidden();
  });

  test('Rate it opens the editor and Save asks a signed-out visitor to sign in', async ({ page }) => {
    await page.goto(`/show/${SHOW_SLUG}`);
    await page.waitForLoadState('networkidle');

    const rateIt = page.getByRole('button', { name: /^rate it$/i });
    if ((await rateIt.count()) === 0) {
      test.skip(true, 'User accounts feature not enabled');
      return;
    }
    await rateIt.first().click();
    const editor = page.locator('[data-testid="rating-editor"]');
    await expect(editor).toBeVisible({ timeout: 5000 });

    // Visitors rate first; sign-in is asked at Save, with the draft kept.
    await editor.getByRole('button', { name: '4 stars' }).click();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(signInDialog(page)).toBeVisible({ timeout: 5000 });
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
  // The old version keyed on `[class*="flex-shrink-0"][class*="flex-col"]`,
  // which only ever matched the legacy header's poster column, so it never
  // looked at stars and went red the day the redesigned hero replaced it.
  test('show page and rating stars fit a phone screen', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width > 500) {
      test.skip(true, 'Only relevant on mobile viewport');
      return;
    }

    await page.goto(`/show/${SHOW_SLUG}`);
    await page.waitForLoadState('networkidle');

    // Runs on every host and layout, so this test never passes having checked nothing.
    const sideScroll = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideScroll).toBeLessThanOrEqual(0);

    const rateIt = page.getByRole('button', { name: /^rate it$/i });
    if ((await rateIt.count()) === 0) return; // accounts not live on this host
    await rateIt.first().click();
    const editor = page.locator('[data-testid="rating-editor"]');
    await expect(editor).toBeVisible({ timeout: 5000 });

    const stars = editor.getByRole('radiogroup', { name: 'Star rating' }).getByRole('button');
    await expect(stars).toHaveCount(5);
    const editorBox = await editor.boundingBox();
    expect(editorBox).not.toBeNull();
    for (let i = 0; i < 5; i++) {
      const box = await stars.nth(i).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(editorBox!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(editorBox!.x + editorBox!.width);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    }
  });
});
