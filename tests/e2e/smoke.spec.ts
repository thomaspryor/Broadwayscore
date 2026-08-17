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
   * a real browser computes, on the real deployed site.
   *
   * It deliberately does NOT name the font. This spec runs against production
   * (TEST_BASE_URL, test.yml e2e-tests) on PRs too, so a build that renames the
   * family — exactly what the self-hosting fix does, `__Inter_<hash>` becoming
   * `InterVariable` — must not fail here before it has shipped. Naming the
   * family would also make this a spelling check rather than a health check.
   * Instead it asserts the property that was violated and that any healthy
   * build satisfies: the family the browser actually paints with is a webfont
   * this site loaded, not a fallback the browser reached for on its own. That
   * holds for the old next/font build and the self-hosted one alike, and it
   * still catches a 404ing woff2, a bad CSP, a broken @font-face, or a future
   * font swap.
   */
  test('pages render in a real loaded webfont, not the browser default', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);

    const heading = page.locator('h1').first();
    await expect(heading).toBeVisible({ timeout: 15000 });

    const { primary, loadedFamilies } = await heading.evaluate((el) => {
      const stack = window.getComputedStyle(el).fontFamily;
      // First entry of the stack, unquoted — what the browser paints with.
      const first = (stack.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
      return {
        primary: first,
        loadedFamilies: Array.from(document.fonts)
          .filter((f) => f.status === 'loaded')
          .map((f) => f.family.replace(/^["']|["']$/g, '')),
      };
    });

    // The incident symptom, stated directly: an invalid font-family declaration
    // drops to the property's initial value, which is the browser default serif.
    expect(primary).not.toMatch(/^(Times New Roman|Times|serif)$/i);

    // And the primary family must be one this site actually fetched. This is
    // what separates a healthy build from every failure mode: if the CSS var
    // was undefined, or the woff2 404'd, or the CSP blocked it, the painted
    // family is a system font that appears nowhere in document.fonts.
    expect(
      loadedFamilies,
      `computed primary family "${primary}" is not among the webfonts this page ` +
        `loaded (${JSON.stringify(loadedFamilies)}) — the page is painting in a ` +
        `browser fallback, not the site's font`
    ).toContain(primary);
  });
});
