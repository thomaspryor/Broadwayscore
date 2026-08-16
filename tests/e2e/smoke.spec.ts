import { test, expect } from '@playwright/test';

/**
 * Post-deploy smoke tests — verify critical pages render content, not just HTTP 200.
 *
 * These run against production after every deploy (vercel-deploy.yml).
 * They catch: error boundaries, missing data, broken layouts, SSG failures.
 *
 * Design: fast (<30s total), no auth, no dev server, chromium only.
 */

test.describe('Post-deploy smoke tests', () => {
  test('homepage renders show cards with scores', async ({ page }) => {
    await page.goto('/');

    // Page loads with correct title
    await expect(page).toHaveTitle(/Broadway/i);

    // Show cards are present (not an empty page or error boundary).
    //
    // Count the hydrated grid, not whatever has painted so far. page.tsx
    // server-renders the "Best Recent Shows" shelf first and HomePageClient
    // renders the real grid after, so a bare count() here resolves to the shelf
    // on a slow runner — 6 links with the CPU throttled 6x today. That shelf is
    // seasonal (see the long note in homepage.spec.ts) and drops to 5 when
    // Ragtime closes 2026-08-16, at which point `> 5` would have started failing
    // this post-deploy smoke test on a healthy site.
    const showLinks = page.locator('a[href^="/show/"]');
    await expect(showLinks.first()).toBeVisible({ timeout: 15000 });

    const grid = page.getByRole('list', { name: 'Broadway shows' });
    await expect(grid).toBeVisible({ timeout: 15000 });
    await expect
      .poll(() => grid.locator('a[href^="/show/"]').count(), { timeout: 15000 })
      .toBeGreaterThan(5);

    // No "undefined" or "NaN" in visible text (common rendering bugs)
    // innerText returns only rendered/visible text, skipping JSON-LD and RSC payloads
    const visibleText = await page.locator('body').innerText();
    expect(visibleText).not.toMatch(/\bundefined\b/);
    expect(visibleText).not.toContain('NaN');
  });

  test('show page renders title, score, and reviews', async ({ page }) => {
    await page.goto('/show/wicked');

    // Show title is visible
    const heading = page.locator('h1');
    await expect(heading).toBeVisible({ timeout: 15000 });
    const title = await heading.textContent();
    expect(title?.toLowerCase()).toContain('wicked');

    // Score is present (two-digit number visible on page)
    const visibleText = await page.locator('body').innerText();
    expect(visibleText).toMatch(/\d{2}/);

    // Reviews section exists
    const reviewContent = page.locator('text=review').first();
    await expect(reviewContent).toBeVisible({ timeout: 5000 });

    // No rendering bugs
    expect(visibleText).not.toMatch(/\bundefined\b/);
    expect(visibleText).not.toContain('NaN');
  });

  test('best-of page renders ranked show list', async ({ page }) => {
    await page.goto('/best/musicals');

    // Page has a heading
    const heading = page.locator('h1');
    await expect(heading).toBeVisible({ timeout: 15000 });

    // Shows are listed
    const showLinks = page.locator('a[href^="/show/"]');
    await expect(showLinks.first()).toBeVisible({ timeout: 10000 });
    const count = await showLinks.count();
    expect(count).toBeGreaterThan(3);

    // No rendering bugs
    const visibleText = await page.locator('body').innerText();
    expect(visibleText).not.toMatch(/\bundefined\b/);
    expect(visibleText).not.toContain('NaN');
  });

  test('tony awards page renders categories', async ({ page }) => {
    await page.goto('/tony-awards');

    // Page loads
    const heading = page.locator('h1');
    await expect(heading).toBeVisible({ timeout: 15000 });

    // Has category content (Best Musical, Best Play, etc.)
    const visibleText = await page.locator('body').innerText();
    expect(visibleText).toMatch(/best\s+(musical|play|revival)/i);

    // No rendering bugs
    expect(visibleText).not.toMatch(/\bundefined\b/);
    expect(visibleText).not.toContain('NaN');
  });

  test('west end page renders WE shows', async ({ page }) => {
    await page.goto('/west-end');

    // Page loads — h1 is hidden on mobile (hidden sm:block), so check tagline instead
    const tagline = page.getByText('Every show. Every review. One score.').first();
    await expect(tagline).toBeVisible({ timeout: 15000 });

    // Has show content
    const showLinks = page.locator('a[href^="/show/"]');
    await expect(showLinks.first()).toBeVisible({ timeout: 10000 });
    const count = await showLinks.count();
    expect(count).toBeGreaterThan(3);

    // No rendering bugs
    const visibleText = await page.locator('body').innerText();
    expect(visibleText).not.toMatch(/\bundefined\b/);
    expect(visibleText).not.toContain('NaN');
  });

  test('biz page renders investment tracker', async ({ page }) => {
    await page.goto('/biz');

    const heading = page.locator('h1');
    await expect(heading).toBeVisible({ timeout: 15000 });

    // Has show data (table rows or show links)
    const visibleText = await page.locator('body').innerText();
    expect(visibleText.length).toBeGreaterThan(500);

    expect(visibleText).not.toMatch(/\bundefined\b/);
    expect(visibleText).not.toContain('NaN');
  });

  test('audience buzz page renders scores', async ({ page }) => {
    await page.goto('/audience-buzz');

    const heading = page.locator('h1');
    await expect(heading).toBeVisible({ timeout: 15000 });

    // Has show content
    const showLinks = page.locator('a[href^="/show/"]');
    await expect(showLinks.first()).toBeVisible({ timeout: 10000 });

    const visibleText = await page.locator('body').innerText();
    expect(visibleText).not.toMatch(/\bundefined\b/);
    expect(visibleText).not.toContain('NaN');
  });

  /**
   * The site actually renders in its own font.
   *
   * On 2026-08-16 production served every page in Times New Roman for an
   * unknown length of time. next/font/google's generated class is
   * `__variable_<sha1(the CSS Google returns at build time)>`; Google's Inter
   * response drifts and `.next/cache` is persisted across deploys, so the HTML
   * shipped `class="__variable_b9631e"` while the CSS only defined
   * `.__variable_d0be19{--font-inter:...}`. An undefined custom property makes
   * the whole `font-family: var(--font-inter), Inter, ...` declaration invalid
   * at computed-value time, and CSS then uses the property's INITIAL value
   * rather than the next family in the stack — so the Arial/sans-serif tail
   * that looked like a safety net never applied.
   *
   * Every gate in the pipeline was green throughout, because they all check
   * source or HTTP status. This checks the thing that was actually wrong: what
   * a real browser computes, on the real deployed site. Inter is self-hosted
   * now, but this assertion is deliberately mechanism-agnostic — it catches a
   * 404 on the woff2, a bad CSP, a broken @font-face, or any future swap.
   */
  test('pages render in Inter, not the browser default serif', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);

    const heading = page.locator('h1').first();
    await expect(heading).toBeVisible({ timeout: 15000 });

    const computed = await heading.evaluate((el) => window.getComputedStyle(el).fontFamily);

    // The declaration must resolve to our font first, not to a bare fallback.
    expect(computed).toMatch(/InterVariable/i);
    // The exact symptom of the incident, asserted directly.
    expect(computed).not.toMatch(/^["']?Times New Roman/i);

    // ...and the face must really have loaded, not just been asked for. A
    // 404ing woff2 leaves the computed stack intact while the page paints in
    // the fallback, so the computed value alone is not sufficient proof.
    const loaded = await page.evaluate(() =>
      Array.from(document.fonts)
        .filter((f) => f.status === 'loaded')
        .map((f) => f.family)
    );
    expect(loaded.join(',')).toMatch(/InterVariable/i);
  });
});
