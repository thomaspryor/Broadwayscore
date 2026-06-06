import { test, expect, Page } from '@playwright/test';

/**
 * Beat the Critics — E2E feature tests
 *
 * Run against production (baseURL from playwright.config.ts).
 * Email-submit API is mocked via page.route() to avoid real submissions.
 *
 * PICKS_REVEALED is false until 2026-06-08, so all critic rows show "Revealed June 7".
 *
 * Nominees are shuffled per session — always target the first visible button
 * rather than picking by title text.
 */

const BTC_URL = '/beat-the-critics';
const RULES_URL = '/beat-the-critics/rules';
const PICKS_API = '**/api/beat-the-critics/send-picks';

/** Mock the send-picks API so no real submission is made. */
async function mockPicksApi(page: Page, response: Record<string, unknown> = { success: true }, status = 200) {
  await page.route(PICKS_API, route => {
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) });
  });
}

/** Navigate to BTC landing and wait for the page to be interactive. */
async function gotoLanding(page: Page) {
  await page.goto(BTC_URL);
  // Wait for the main CTA — proves React hydration is complete
  await expect(page.getByRole('button', { name: /Make Your Picks/i })).toBeVisible({ timeout: 20000 });
}

/** Click "Make Your Picks" and wait for the picking screen. */
async function startPicking(page: Page) {
  await page.getByRole('button', { name: /Make Your Picks/i }).click();
  // Picking screen has the category heading and nominee list
  await expect(page.getByRole('button', { name: /Lock In/i })).toBeVisible({ timeout: 10000 });
}

/** Select the first nominee button in the picking screen. */
async function pickFirstNominee(page: Page) {
  // Nominee cards are buttons inside the nominee list — exclude nav/header buttons
  const nomineeButtons = page.locator('.flex.flex-col.gap-2\\.5 button, [class*="flex-col"][class*="gap"] button').filter({ hasNotText: /Lock In|Back|Keep Going/i });
  await nomineeButtons.first().waitFor({ state: 'visible', timeout: 10000 });
  await nomineeButtons.first().click();
}

/** Lock in the current pick and wait for the reveal screen. */
async function lockIn(page: Page) {
  const lockBtn = page.getByRole('button', { name: /Lock In/i });
  await expect(lockBtn).toBeEnabled({ timeout: 5000 });
  await lockBtn.click();
  // Reveal screen has "Keep Going" or "Complete Round" or "See My Ballot"
  await expect(
    page.getByRole('button', { name: /Keep Going|Complete Round|See My Ballot/i }).first()
  ).toBeVisible({ timeout: 10000 });
}

// ─── Landing Page ──────────────────────────────────────────────────────────

test.describe('landing page', () => {
  test('renders title, countdown, prize pill, Make Your Picks button, 3 critic cards', async ({ page }) => {
    await gotoLanding(page);

    // Title
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Beat.*the Critics/i);

    // Countdown — four time-unit blocks
    await expect(page.getByText(/Days/i).first()).toBeVisible();
    await expect(page.getByText(/Hrs/i).first()).toBeVisible();
    await expect(page.getByText(/Min/i).first()).toBeVisible();
    await expect(page.getByText(/Sec/i).first()).toBeVisible();

    // Prize pill — match any $N TodayTix mention so the test survives prize
    // amount tweaks (2026-05-26: prize bumped from $100 to $200 in ec149566f6
    // without updating this assertion, broke E2E across all PRs).
    await expect(page.getByText(/\$\d+ TodayTix/i).first()).toBeVisible();

    // CTA button
    await expect(page.getByRole('button', { name: /Make Your Picks/i })).toBeVisible();

    // 3 critic cards (grid contains 3 buttons)
    const criticGrid = page.locator('.grid.grid-cols-3');
    await expect(criticGrid).toBeVisible();
    const criticButtons = criticGrid.getByRole('button');
    await expect(criticButtons).toHaveCount(3);

    // No rendering bugs
    const visibleText = await page.locator('body').innerText();
    expect(visibleText).not.toMatch(/\bundefined\b/);
    expect(visibleText).not.toContain('NaN');
  });

  test('each critic card shows name, outlet, bio (3-line clamped by default)', async ({ page }) => {
    await gotoLanding(page);

    const criticGrid = page.locator('.grid.grid-cols-3');
    const cards = criticGrid.getByRole('button');

    // Check first critic (Dan Rubins — always present)
    const first = cards.nth(0);
    await expect(first).toContainText('Dan Rubins');
    // Bio text is clamped — check it exists in the DOM even if not fully visible
    const bioEl = first.locator('.line-clamp-3');
    await expect(bioEl).toBeAttached();
    const bioText = await bioEl.textContent();
    expect(bioText?.length).toBeGreaterThan(10);
  });

  test('critic card expands bio on click', async ({ page }) => {
    await gotoLanding(page);

    const criticGrid = page.locator('.grid.grid-cols-3');
    const firstCard = criticGrid.getByRole('button').nth(0);

    // Before click: bio is clamped
    const bio = firstCard.locator('.line-clamp-3');
    await expect(bio).toBeAttached();

    // Click to expand
    await firstCard.click();

    // After click: line-clamp-3 class should be removed from that card's bio
    // The component sets expanded state, removing line-clamp-3 from that item
    const expandedBio = firstCard.locator('div').filter({ hasNotText: /\bline-clamp-3\b/ }).last();
    // Verify the same card no longer has line-clamp-3 on the bio paragraph
    const hasClamp = await firstCard.locator('.line-clamp-3').count();
    expect(hasClamp).toBe(0);
  });
});

// ─── Picking Flow — Tier 1 (The Big Four) ─────────────────────────────────

test.describe('picking flow — Tier 1 (The Big Four)', () => {
  test('clicking Make Your Picks shows picking screen with category title', async ({ page }) => {
    await gotoLanding(page);
    await startPicking(page);

    // Category heading is visible (e.g. "Best Musical")
    const heading = page.getByRole('heading', { level: 2 });
    await expect(heading).toBeVisible();
    const headingText = await heading.textContent();
    expect(headingText).toBeTruthy();
    expect(headingText?.length).toBeGreaterThan(3);
  });

  test('can select a nominee (button gets selected state)', async ({ page }) => {
    await gotoLanding(page);
    await startPicking(page);

    const nomineeButtons = page.locator('.flex.flex-col.gap-2\\.5 button').filter({ hasNotText: /Lock In|Back/i });
    const first = nomineeButtons.first();
    await first.waitFor({ state: 'visible', timeout: 10000 });
    await first.click();

    // Selected state: button gains the rose border class
    await expect(first).toHaveClass(/border-\[#ff1368\]/);
  });

  test('Lock In button is disabled until a pick is made', async ({ page }) => {
    await gotoLanding(page);
    await startPicking(page);

    const lockBtn = page.getByRole('button', { name: /Lock In Pick/i });
    await expect(lockBtn).toBeDisabled();

    // After picking, button becomes enabled and label changes
    await pickFirstNominee(page);
    const enabledLock = page.getByRole('button', { name: /Lock In:/i });
    await expect(enabledLock).toBeEnabled();
  });

  test('locking in navigates to reveal screen', async ({ page }) => {
    await gotoLanding(page);
    await startPicking(page);
    await pickFirstNominee(page);
    await lockIn(page);

    // Reveal screen header
    await expect(page.getByText("Here's what the experts picked")).toBeVisible({ timeout: 10000 });
  });

  test('reveal screen shows a "Revealed <date>" badge for all 3 critics (PICKS_REVEALED=false)', async ({ page }) => {
    await gotoLanding(page);
    await startPicking(page);
    await pickFirstNominee(page);
    await lockIn(page);

    // Before the reveal date each critic row shows a "Revealed <date>" badge.
    // Match on the stable "Revealed " prefix, NOT a hardcoded date — the reveal
    // date is config-driven (PICKS_REVEAL_DATE in BeatTheCriticsClient.tsx) and
    // has already moved June 7 → June 8 once, silently breaking this test.
    const revealBadges = page.getByText(/^Revealed /);
    const count = await revealBadges.count();
    // 3 critics in the CRITICS panel → 3 badges.
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('Keep Going advances to next category', async ({ page }) => {
    await gotoLanding(page);
    await startPicking(page);

    const firstHeading = await page.getByRole('heading', { level: 2 }).textContent();

    await pickFirstNominee(page);
    await lockIn(page);

    // Keep Going button
    const keepGoing = page.getByRole('button', { name: /Keep Going/i });
    await expect(keepGoing).toBeVisible({ timeout: 10000 });
    await keepGoing.click();

    // Should be on a different category now
    const nextHeading = page.getByRole('heading', { level: 2 });
    await expect(nextHeading).toBeVisible({ timeout: 10000 });
    const nextHeadingText = await nextHeading.textContent();
    expect(nextHeadingText).not.toEqual(firstHeading);
  });
});

// ─── Picks Persist Across Reload ──────────────────────────────────────────

test.describe('picks persist across reload', () => {
  test('previously picked nominee is still selected after page reload', async ({ page }) => {
    await gotoLanding(page);
    await startPicking(page);

    // Pick the first nominee and record its text
    const nomineeButtons = page.locator('.flex.flex-col.gap-2\\.5 button').filter({ hasNotText: /Lock In|Back/i });
    await nomineeButtons.first().waitFor({ state: 'visible', timeout: 10000 });
    const pickedTitle = await nomineeButtons.first().locator('.text-\\[15px\\]').textContent();

    await nomineeButtons.first().click();
    // Wait for selection to register (localStorage write)
    await expect(nomineeButtons.first()).toHaveClass(/border-\[#ff1368\]/);

    // Reload and navigate back to picking
    await page.reload();
    await expect(page.getByRole('button', { name: /Make Your Picks/i })).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: /Make Your Picks/i }).click();
    await expect(page.getByRole('button', { name: /Lock In/i })).toBeVisible({ timeout: 10000 });

    // The previously picked nominee should still be selected (from localStorage)
    if (pickedTitle) {
      const selectedBtn = page.locator('button').filter({ hasText: pickedTitle }).first();
      await expect(selectedBtn).toHaveClass(/border-\[#ff1368\]/, { timeout: 5000 });
    }

    // No rendering bugs after reload
    const visibleText = await page.locator('body').innerText();
    expect(visibleText).not.toMatch(/\bundefined\b/);
    expect(visibleText).not.toContain('NaN');
  });
});

// ─── Results Ballot ────────────────────────────────────────────────────────

test.describe('results ballot', () => {
  /**
   * Pick through all 4 Tier 1 categories then navigate to results.
   * Mocks the send-picks API.
   */
  async function reachResultsScreen(page: Page) {
    await mockPicksApi(page);
    await gotoLanding(page);
    await startPicking(page);

    // Pick through all categories in Tier 1 until we hit tier-complete or results
    let safety = 0;
    while (safety++ < 20) {
      // Are we on the picking screen?
      const lockBtn = page.getByRole('button', { name: /Lock In/i });
      const isOnPicking = await lockBtn.isVisible().catch(() => false);
      if (isOnPicking) {
        await pickFirstNominee(page);
        await lockIn(page);
        continue;
      }

      // Are we on the reveal screen?
      const keepGoing = page.getByRole('button', { name: /Keep Going/i });
      const isOnReveal = await keepGoing.isVisible().catch(() => false);
      if (isOnReveal) {
        await keepGoing.click();
        continue;
      }

      // Complete Round / See My Ballot button
      const completeBtn = page.getByRole('button', { name: /Complete Round|See My Ballot/i }).first();
      const isOnComplete = await completeBtn.isVisible().catch(() => false);
      if (isOnComplete) {
        await completeBtn.click();
        continue;
      }

      // Tier-complete → Continue or Save
      const tierBtn = page.getByRole('button', { name: /Continue to|Save & Share/i }).first();
      const isOnTier = await tierBtn.isVisible().catch(() => false);
      if (isOnTier) {
        // Go straight to results
        const saveBtn = page.getByRole('button', { name: /Save.*Ballot/i });
        if (await saveBtn.isVisible().catch(() => false)) {
          await saveBtn.click();
        } else {
          await tierBtn.click();
        }
        continue;
      }

      // Are we on results?
      const ballot = page.getByText('Your Ballot');
      if (await ballot.isVisible().catch(() => false)) break;

      // Nothing matched — break to avoid infinite loop
      break;
    }

    await expect(page.getByText('Your Ballot')).toBeVisible({ timeout: 15000 });
  }

  test('results screen shows "Your Ballot" with picks listed', async ({ page }) => {
    await reachResultsScreen(page);

    // Ballot card is rendered
    await expect(page.getByText('My Tony Picks')).toBeVisible();

    // At least one pick row is rendered
    const pickRows = page.locator('.flex.items-center.justify-between.py-1\\.5');
    await expect(pickRows.first()).toBeVisible({ timeout: 10000 });

    const visibleText = await page.locator('body').innerText();
    expect(visibleText).not.toMatch(/\bundefined\b/);
    expect(visibleText).not.toContain('NaN');
  });

  test('email input rejects bad email and accepts good email triggering mocked API', async ({ page }) => {
    await reachResultsScreen(page);

    const emailInput = page.getByPlaceholder(/you@email.com/i);
    await expect(emailInput).toBeVisible({ timeout: 10000 });

    // Submit with bad email
    await emailInput.fill('not-valid');
    await page.getByRole('button', { name: /Submit/i }).click();
    await expect(page.getByText(/valid email/i)).toBeVisible({ timeout: 5000 });

    // Submit with good email (mocked API returns {success:true})
    await emailInput.fill('test@example.com');
    await page.getByRole('button', { name: /Submit/i }).click();
    await expect(page.getByText(/entered/i)).toBeVisible({ timeout: 10000 });

    const visibleText = await page.locator('body').innerText();
    expect(visibleText).not.toMatch(/\bundefined\b/);
    expect(visibleText).not.toContain('NaN');
  });
});

// ─── Rules Page ────────────────────────────────────────────────────────────

test.describe('rules page', () => {
  test('renders with "Official Rules" heading and prize info', async ({ page }) => {
    await page.goto(RULES_URL);

    // Must have an Official Rules heading
    const heading = page.getByRole('heading', { name: /Official Rules/i });
    await expect(heading).toBeVisible({ timeout: 20000 });

    // Prize info is on the page
    const visibleText = await page.locator('body').innerText();
    expect(visibleText).toMatch(/\$\d+|prize|TodayTix/i);

    // No rendering bugs
    expect(visibleText).not.toMatch(/\bundefined\b/);
    expect(visibleText).not.toContain('NaN');
  });
});
