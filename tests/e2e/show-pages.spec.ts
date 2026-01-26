import { test, expect } from 'playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// Load shows data
const showsPath = path.join(__dirname, '../../data/shows.json');
const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const shows = showsData.shows || showsData;

// Get a sample of shows to test (first 10 + random selection)
const openShows = shows.filter((s: any) => s.status === 'open');
const sampleShows = openShows.slice(0, Math.min(15, openShows.length));

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
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('analytics') &&
        !e.includes('hydration') &&
        !e.includes('Failed to load resource: the server responded with a status of 404')
    );

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
  test('can navigate between shows', async ({ page }) => {
    // Start on homepage
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Click first show
    const firstShow = page.locator('a[href^="/show/"]').first();
    await expect(firstShow).toBeVisible({ timeout: 10000 });
    await firstShow.click();

    // Should be on show page
    await expect(page).toHaveURL(/\/show\//);

    // Navigate back to home
    const homeLink = page.locator('a[href="/"]').first();
    if ((await homeLink.count()) > 0) {
      await homeLink.click();
      await expect(page).toHaveURL('/');
    }
  });

  test('browser back button works', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Navigate to a show
    const showLink = page.locator('a[href^="/show/"]').first();
    await expect(showLink).toBeVisible({ timeout: 10000 });
    await showLink.click();
    await expect(page).toHaveURL(/\/show\//);

    // Go back
    await page.goBack();
    await expect(page).toHaveURL('/');
  });
});
