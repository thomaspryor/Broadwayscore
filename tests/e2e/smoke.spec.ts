import { test, expect, AD_NETWORK_URL_RE } from './helpers/test';
import { skipOnPrUntilLive } from './helpers/feature-flags';

// AdSense script and ad-serving hosts (subset of AD_NETWORK_URL_RE).
const ADSENSE_HOST_RE = /googlesyndication\.com|adtrafficquality\.google/i;

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
    // Visible only: the hero's "Based on N Critic Reviews" line is desktop-only.
    const reviewContent = page.locator('text=review').filter({ visible: true }).first();
    await expect(reviewContent).toBeVisible({ timeout: 5000 });

    // No rendering bugs
    expect(visibleText).not.toMatch(/\bundefined\b/);
    expect(visibleText).not.toContain('NaN');
  });

  // AdSense invalid-traffic guard (BRO-5893, B-T4). Even with the PostHog
  // `ads` flag forced to `ads` and a US region cookie, an automated browser
  // must never render an ad unit or request Google's ad script: our own CI
  // impressions count as invalid traffic. helpers/test.ts aborts these
  // requests, but the 'request' event still fires, so this counts attempts.
  test('show page loads no ads for automation, even with the ads flag forced on', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'bwsc_ad_region', value: 'ads-ok', url: baseURL || 'https://broadwayscorecard.com' }]);
    await page.addInitScript(() => {
      type PH = { getFeatureFlag?: (k: string) => unknown; __adsForced?: boolean };
      let ph: PH | undefined;
      const force = (v: PH | undefined) => {
        if (v && typeof v.getFeatureFlag === 'function' && !v.__adsForced) {
          const orig = v.getFeatureFlag.bind(v);
          v.getFeatureFlag = (k: string) => (k === 'ads' ? 'ads' : orig(k));
          v.__adsForced = true;
        }
        return v;
      };
      Object.defineProperty(window, 'posthog', {
        configurable: true,
        get: () => force(ph),
        set: (v: PH) => { ph = v; },
      });
    });
    const adRequests: string[] = [];
    page.on('request', (r) => {
      // AdSense hosts only: gtag can beacon stats.g.doubleclick.net (Google
      // Signals), which is analytics, not ads.
      if (AD_NETWORK_URL_RE.test(r.url()) && ADSENSE_HOST_RE.test(r.url())) adRequests.push(r.url());
    });
    await page.goto('/show/wicked');
    await expect(page.locator('h1')).toBeVisible({ timeout: 15000 });
    await page.locator('#critic-reviews').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 3000)); // mouse.wheel throws in mobile WebKit
    await page.waitForTimeout(6000); // past usePostHogFlag's 5s poll window
    await expect(page.locator('ins.adsbygoogle, [data-testid="ad-slot"]')).toHaveCount(0);
    expect(adRequests, 'requests to Google ad networks').toEqual([]);
  });

  // Accounts are live on prod (BRO-4525). A deploy that ships the flag but
  // breaks the client (bad Supabase env, CSP blocking the auth script, a
  // hydration error in the header) would leave the button dead or missing
  // while every page above still renders. Open the sign-in modal; never
  // submit it. Phones get their own pass: below sm (640px) the header button is
  // hidden and Sign In sits in the menu. The deploy runs chromium only, so the
  // width is set here instead of relying on the mobile project.
  for (const width of [1280, 390]) {
    test(`signed-out visitor can open the sign-in options at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/show/wicked');
      await expect(page.locator('h1')).toBeVisible({ timeout: 15000 });

      const phone = width < 640;
      // Phones: the menu's My Shows card button (BRO-4616). Desktop: the site
      // header's button only. The page body can carry its own "Sign in" (the
      // Profitability Scorecard panel does), and an unscoped locator then
      // matches two buttons and fails strict mode on every deploy (BRO-6468).
      const signIn = phone
        ? page.getByRole('button', { name: /^Sign in (· free|to keep them)$/ })
        : page.locator('header').first().getByRole('button', { name: 'Sign in', exact: true });
      const google = page.getByRole('button', { name: 'Continue with Google' });
      // The header is server-rendered, so a click that lands before hydration
      // does nothing. Retry the open until the modal shows. Open menu only ever
      // opens, so clicking it again is safe.
      await expect(async () => {
        if (await google.isVisible()) return;
        if (phone && !(await signIn.isVisible())) await page.getByRole('button', { name: 'Open menu' }).click({ timeout: 2000 });
        await signIn.click({ timeout: 2000 });
        await expect(google).toBeVisible({ timeout: 3000 });
      }).toPass({ timeout: 30000 });
      await expect(page.getByRole('button', { name: 'Continue with Apple' })).toBeVisible();
    });
  }

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

  // The Profitability Scorecard was released 2026-10-26 (BRO-6192). Before that this
  // asserted /biz was a 404; now it checks the hub, a browse page built on the
  // data and the discovery surfaces (llms.txt, sitemap) all serve it, and that
  // /biz is indexable. A 404 page also has an h1, so check the status code.
  test('Profitability Scorecard is live', async ({ request }) => {
    await skipOnPrUntilLive(request, '/biz');
    for (const p of ['/biz', '/browse/biggest-broadway-flops']) {
      const res = await request.get(p, { maxRedirects: 0 });
      expect(res.status(), `${p} should be live since the Profitability Scorecard launch`).toBe(200);
    }
    const biz = await (await request.get('/biz')).text();
    expect(biz).toContain('Profitability Scorecard');
    expect(biz).not.toMatch(/<meta[^>]+name="robots"[^>]+noindex/);

    expect(await (await request.get('/llms.txt')).text()).toContain('Profitability Scorecard');
    expect(await (await request.get('/llms.txt')).text()).toContain('/biz)');
    expect(await (await request.get('/sitemap/0.xml')).text()).toMatch(/\/biz</);
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

    const heading = page.locator('h1').first();
    await expect(heading).toBeVisible({ timeout: 15000 });
    // Await fonts.ready AFTER the heading is up: faces requested during
    // hydration can still be in flight if we settle the set too early.
    await page.evaluate(() => document.fonts.ready);

    const { primary, loadedFamilies, paintsLatin } = await heading.evaluate((el) => {
      const stack = window.getComputedStyle(el).fontFamily;
      // First entry of the stack, unquoted — what the browser paints with.
      const first = (stack.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
      return {
        primary: first,
        loadedFamilies: Array.from(document.fonts)
          .filter((f) => f.status === 'loaded')
          .map((f) => f.family.replace(/^["']|["']$/g, '')),
        // The latin and latin-ext faces share ONE family name, so "the family
        // loaded" is satisfied by either. A 404 on the latin subset — the one
        // almost every glyph on the page needs, and the one we preload — would
        // still pass that check whenever a single accented character pulled in
        // latin-ext. Ask the font matcher directly about plain ASCII instead.
        paintsLatin: document.fonts.check(`1em "${first}"`, 'Broadway'),
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

    // ...and specifically for ordinary latin text, not just whatever subset
    // happened to be pulled in by one accented character.
    expect(
      paintsLatin,
      `"${primary}" is loaded, but the face covering plain latin text is not — the ` +
        `main subset probably 404'd while a secondary one loaded, so most of the page ` +
        `is painting in a fallback`
    ).toBe(true);
  });
});
