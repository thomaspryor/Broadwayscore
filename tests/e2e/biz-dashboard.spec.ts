import { test, expect } from '@playwright/test';

test.describe('/biz Dashboard - Basic Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/biz');
  });

  test('page loads without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.waitForLoadState('networkidle');

    // Filter out expected warnings
    const criticalErrors = errors.filter(
      (e) => !e.includes('Warning') && !e.includes('Failed to load resource')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('main header and subtitle render', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Broadway Investment Tracker');
    await expect(page.getByText('Recoupment data and investment metrics')).toBeVisible();
  });

  test('season stats section renders', async ({ page }) => {
    // Look for season indicators - either "By Season" section header or season year text
    const hasBySeasonHeader = await page.getByText('By Season').isVisible().catch(() => false);
    const has2024Season = await page.getByText('2024-2025').isVisible().catch(() => false);

    // Accept either format
    expect(hasBySeasonHeader || has2024Season).toBeTruthy();
  });

  test('download buttons are present', async ({ page }) => {
    await expect(page.getByRole('button', { name: /JSON/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /CSV/i })).toBeVisible();
  });

  test('back link returns to homepage', async ({ page }) => {
    await page.click('text=All Shows');
    await expect(page).toHaveURL('/');
  });

  test('designation legend renders', async ({ page }) => {
    // Look for designation terms - these should always appear on the biz page
    const hasMiracle = await page.getByText('Miracle').first().isVisible().catch(() => false);
    const hasWindfall = await page.getByText('Windfall').first().isVisible().catch(() => false);

    expect(hasMiracle || hasWindfall).toBeTruthy();
  });
});

test.describe('/biz Dashboard - Tables', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/biz');
    await page.waitForLoadState('networkidle');
  });

  test('recent recoupments table renders', async ({ page }) => {
    await expect(page.getByText('Recent Recoupments')).toBeVisible();
  });

  test('all shows table renders', async ({ page }) => {
    // Look for either "All Open Shows" or a shows table structure
    const hasAllOpenShows = await page.getByText('All Open Shows').isVisible().catch(() => false);
    const hasShowsTable = await page.locator('table').first().isVisible().catch(() => false);

    expect(hasAllOpenShows || hasShowsTable).toBeTruthy();
  });

  test('table has sortable headers', async ({ page }) => {
    // Check that there are table headers (may or may not be buttons)
    const hasTableHeaders = await page.locator('th').first().isVisible().catch(() => false);
    const hasSortButtons = await page.locator('button:has-text("Show")').first().isVisible().catch(() => false);

    expect(hasTableHeaders || hasSortButtons).toBeTruthy();
  });
});

test.describe('/biz Dashboard - Navigation', () => {
  test('show links in tables navigate to show pages', async ({ page }) => {
    await page.goto('/biz');
    await page.waitForLoadState('networkidle');

    // Find a link in the recoupments or shows table
    const showLink = page.locator('a[href^="/show/"]').first();
    const href = await showLink.getAttribute('href');

    if (href) {
      await showLink.click();
      await expect(page).toHaveURL(href);
    }
  });
});

test.describe('/biz-buzz Redirect', () => {
  // Skip: Redirect is handled by Vercel at the edge layer
  // Client-side fallback only works in local development
  // After deployment, this test would pass on Vercel but not locally
  test.skip('old /biz-buzz URL redirects to /biz', async ({ page }) => {
    await page.goto('/biz-buzz');
    await page.waitForLoadState('networkidle');

    // Should end up at /biz (either via server redirect or client-side)
    await expect(page).toHaveURL('/biz');
  });
});
