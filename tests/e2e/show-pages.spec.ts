import { test, expect } from '@playwright/test';
import { filterNonCriticalErrors } from './helpers/console-errors';
import {
  FLIGHT_CHUNK_RE,
  measurePageWeight,
  noFlightPayloadDetectedMessage,
  overBudgetMessage,
} from './helpers/page-weight';
import * as fs from 'fs';
import * as path from 'path';

// Load shows data
const showsPath = path.join(__dirname, '../../data/shows.json');
const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const shows = showsData.shows || showsData;

// Get a sample of shows to test (first 10 + random selection)
const openShows = shows.filter((s: any) => s.status === 'open');
const sampleShows = openShows.slice(0, Math.min(15, openShows.length));

// Card #419's own regression was measured on /show/hamilton (deepest review
// corpus in the catalogue, so the heaviest realistic show page). Fall back to
// the first open show if it's ever closed/renamed so this doesn't go dark.
const weightBudgetShow = openShows.find((s: any) => s.slug === 'hamilton') || sampleShows[0];

test.describe('Show Detail Pages', () => {
  test('all open show pages load without 404', async ({ page }) => {
    const failedShows: string[] = [];

    for (const show of sampleShows) {
      const response = await page.goto(`/show/${show.slug}`);

      if (!response || response.status() === 404) {
        failedShows.push(`${show.title} (${show.slug})`);
      }
    }

    if (failedShows.length > 0) {
      throw new Error(`Shows returning 404:\n${failedShows.join('\n')}`);
    }
  });

  test('show page has required elements', async ({ page }) => {
    // Test first open show
    const show = sampleShows[0];
    await page.goto(`/show/${show.slug}`);
    await page.waitForLoadState('networkidle');

    // Should have the show title somewhere on page
    const pageContent = await page.textContent('body');
    expect(pageContent?.toLowerCase()).toContain(show.title.toLowerCase());

    // Should have a back/home link
    const homeLink = page.locator('a[href="/"], a[href*="home"]');
    const hasHomeLink = (await homeLink.count()) > 0;
    expect(hasHomeLink).toBeTruthy();
  });

  test('show pages have no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Test a few show pages
    for (const show of sampleShows.slice(0, 5)) {
      await page.goto(`/show/${show.slug}`);
      await page.waitForLoadState('networkidle');
    }

    // Filter out non-critical errors
    const criticalErrors = filterNonCriticalErrors(errors);

    if (criticalErrors.length > 0) {
      console.log('Console errors found:', criticalErrors);
    }

    // Allow up to 2 non-critical errors
    expect(criticalErrors.length).toBeLessThan(3);
  });

  test('show page displays venue information', async ({ page }) => {
    const showsWithVenue = sampleShows.filter((s: any) => s.venue && s.venue !== 'TBA');

    if (showsWithVenue.length === 0) {
      test.skip();
      return;
    }

    const show = showsWithVenue[0];
    await page.goto(`/show/${show.slug}`);
    await page.waitForLoadState('networkidle');

    const pageContent = await page.textContent('body');
    // Venue name should appear on page (case-insensitive partial match)
    const venueWords = show.venue.split(' ').filter((w: string) => w.length > 3);
    const hasVenue = venueWords.some((word: string) =>
      pageContent?.toLowerCase().includes(word.toLowerCase())
    );

    expect(hasVenue).toBeTruthy();
  });

  test('show page has score or coming soon indicator', async ({ page }) => {
    const show = sampleShows[0];
    await page.goto(`/show/${show.slug}`);
    await page.waitForLoadState('networkidle');

    // Should have either a score number or some indicator
    const pageContent = await page.textContent('body');

    // Check for score (number) or "coming soon" / "no reviews" type text
    const hasScore = /\d{1,3}(?:\.\d)?/.test(pageContent || '');
    const hasNoScoreIndicator =
      pageContent?.toLowerCase().includes('coming') ||
      pageContent?.toLowerCase().includes('no review') ||
      pageContent?.toLowerCase().includes('not yet');

    expect(hasScore || hasNoScoreIndicator).toBeTruthy();
  });

  // Regression guard for card #419. The show page hands several props to
  // ShowPageBelowFoldLoader ('use client'), and anything crossing that boundary is
  // serialized verbatim into the inlined RSC flight payload. Twice now a prop has
  // been a full ComputedShow/Theater carrying OTHER shows' entire criticScore.reviews
  // arrays (related shows, other productions, the venue's back catalogue) — 645KB of
  // the 781KB /show/hamilton document, none of it rendered, and it fell straight onto
  // LCP for mobile visitors.
  //
  // The invariant: the only review objects a show page may inline are its own. Foreign
  // showIds in the flight payload mean a fat object crossed the boundary again. The
  // TypeScript prop types (ShowCardShow / Pick<Theater,...>) are the first line of
  // defence; this catches whatever the types don't, on the page as actually served.
  test('does not inline other shows\' review objects in the RSC payload', async ({ page }) => {
    // A show with reviews is required: the anti-vacuity check below keys off the
    // page's OWN showId appearing in the payload, which only happens once there is
    // at least one review object to serialize.
    const scored = sampleShows.filter((s: any) => s.status === 'open').slice(0, 3);
    expect(scored.length, 'no open shows to sample').toBeGreaterThan(0);

    for (const show of scored) {
      const response = await page.goto(`/show/${show.slug}`);
      const html = (await response?.text()) ?? '';

      // Flight payload is emitted as self.__next_f.push([1,"...escaped JSON..."]) chunks
      // (FLIGHT_CHUNK_RE, shared with the page-weight budget tests below).
      const flight = (html.match(FLIGHT_CHUNK_RE) || []).join('');
      const ids = Array.from(
        flight.matchAll(/\\"showId\\":\\"([a-z0-9-]+)\\"/g),
        m => m[1],
      );

      // ANTI-VACUITY. Without this the assertion below passes for free the moment
      // Next.js changes its flight-chunk syntax or its string escaping — the regexes
      // stop matching, `ids` is empty, and a guard that can no longer fail silently
      // reports green forever. This is the exact vacuous-guard shape that shipped
      // three times in this repo (#766, #782, #793), so the guard asserts it can
      // still SEE the payload before asserting anything about its contents. If this
      // line fails, fix the regexes — do not delete the check.
      expect(
        ids,
        `Could not find any review objects in the RSC payload for ${show.slug}. `
          + 'Either the page genuinely has no reviews (pick a different sample) or '
          + "Next.js changed its flight-chunk encoding and this test's regexes need "
          + 'updating. Until then the foreign-showId assertion below proves nothing.',
      ).toContain(show.id);

      const foreign = Array.from(new Set(ids)).filter(id => id !== show.id);
      expect(
        foreign,
        `Show page for ${show.slug} inlined review objects belonging to other shows. `
          + 'Something is passing a full ComputedShow/Theater across the '
          + 'ShowPageBelowFoldLoader client boundary again — card-shape it with '
          + 'serializeShowForClient() (see src/app/show/[slug]/page.tsx).',
      ).toEqual([]);
    }
  });

  // Page-weight budget gate (card #961). The only prior signal for the #419
  // class of regression was a weekly Lighthouse lab score oscillating 64-81
  // across weeks and naming the wrong page in the alert. This asserts real
  // uncompressed document bytes and inlined-RSC bytes on every push/PR/daily
  // run instead — see tests/e2e/page-weight-budget.spec.ts for the
  // non-show-page routes (/, /west-end, /off-broadway, guides).
  //
  // Budget = /show/hamilton production document bytes measured 2026-08-03
  // (`curl -s --compressed https://broadwayscorecard.com/show/hamilton | wc
  // -c` = 789,332) x1.25 headroom, rounded up to the nearest 10KB. rscBytes
  // budget = inlined `self.__next_f.push(...)` flight-chunk bytes from that
  // same fetch (660,598), same rounding.
  //
  // NOTE: this page is currently carrying the unresolved bloat tracked by
  // #962 (review arrays serializing into the payload 3x) — this budget locks
  // in TODAY'S weight so it can't get worse, it is not a target. Ratchet it
  // down once #962 lands.
  test('show page stays under its document-weight budget', async ({ page }) => {
    const budget = { documentBytes: 990_000, rscBytes: 830_000 };
    const route = `/show/${weightBudgetShow.slug}`;
    const response = await page.goto(route);
    expect(response?.ok(), `${route} did not return a 2xx response (status ${response?.status()})`).toBeTruthy();

    const html = (await response?.text()) ?? '';
    expect(html.length, `${route} returned an empty response`).toBeGreaterThan(0);

    const measured = measurePageWeight(html);

    // Anti-vacuity: see noFlightPayloadDetectedMessage in helpers/page-weight.ts.
    expect(measured.rscBytes, noFlightPayloadDetectedMessage(route)).toBeGreaterThan(0);

    expect(
      measured.documentBytes,
      overBudgetMessage(route, 'documentBytes', measured.documentBytes, budget.documentBytes),
    ).toBeLessThanOrEqual(budget.documentBytes);

    expect(
      measured.rscBytes,
      overBudgetMessage(route, 'rscBytes', measured.rscBytes, budget.rscBytes),
    ).toBeLessThanOrEqual(budget.rscBytes);
  });

  test('external links open correctly', async ({ page, context }) => {
    const show = sampleShows[0];
    await page.goto(`/show/${show.slug}`);
    await page.waitForLoadState('networkidle');

    // Find external links (ticket links, etc.)
    const externalLinks = page.locator('a[target="_blank"], a[href^="http"]');
    const count = await externalLinks.count();

    if (count === 0) {
      test.skip();
      return;
    }

    // Check first external link has href
    const href = await externalLinks.first().getAttribute('href');
    expect(href).toBeTruthy();
    expect(href).toMatch(/^https?:\/\//);
  });
});

test.describe('Show Page Navigation', () => {
  test('can navigate from homepage to show page', async ({ page }) => {
    // Start on homepage
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Click first show
    const firstShow = page.locator('a[href^="/show/"]').first();
    await expect(firstShow).toBeVisible({ timeout: 10000 });
    await firstShow.click();

    // Should be on show page
    await expect(page).toHaveURL(/\/show\//);

    // Page should have loaded with content
    await expect(page.locator('body')).toBeVisible();
  });

  test('browser back button returns to previous page', async ({ page }) => {
    // Start on homepage, record URL
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const homeUrl = page.url();

    // Navigate to a show
    const showLink = page.locator('a[href^="/show/"]').first();
    await expect(showLink).toBeVisible({ timeout: 10000 });
    await showLink.click();
    await expect(page).toHaveURL(/\/show\//);

    // Go back
    await page.goBack();
    await page.waitForLoadState('networkidle');

    // Should be back at original URL
    expect(page.url()).toBe(homeUrl);
  });
});
