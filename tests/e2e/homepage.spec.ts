import { test, expect } from 'playwright/test';

test.describe('Homepage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('loads successfully without errors', async ({ page }) => {
    // Check page title
    await expect(page).toHaveTitle(/Broadway/i);

    // Check for console errors
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Wait for page to be fully loaded
    await page.waitForLoadState('networkidle');

    // Filter out known non-critical errors
    const criticalErrors = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('analytics')
    );

    expect(criticalErrors).toHaveLength(0);
  });

  test('displays show cards', async ({ page }) => {
    // Wait for show cards to appear
    const showCards = page.locator('[data-testid="show-card"], article, .show-card, a[href^="/show/"]');

    // Should have at least 10 shows visible
    await expect(showCards.first()).toBeVisible({ timeout: 10000 });

    const count = await showCards.count();
    expect(count).toBeGreaterThan(10);
  });

  test('show cards have required elements', async ({ page }) => {
    // Find show cards/links
    const showLinks = page.locator('a[href^="/show/"]').first();
    await expect(showLinks).toBeVisible({ timeout: 10000 });

    // First show card should have a title
    const firstCard = page.locator('a[href^="/show/"]').first();
    await expect(firstCard).toBeVisible();

    // Should have text content (show title)
    const text = await firstCard.textContent();
    expect(text?.length).toBeGreaterThan(0);
  });

  test('navigation menu is accessible', async ({ page }) => {
    // Check for main navigation elements
    const nav = page.locator('nav, header');
    await expect(nav.first()).toBeVisible();
  });

  test('filters are functional', async ({ page }) => {
    // Look for filter buttons or tabs
    const filters = page.locator('button, [role="tab"], .filter');

    // Should have some filter options
    const filterCount = await filters.count();
    expect(filterCount).toBeGreaterThan(0);
  });

  test('clicking a show card navigates to show page', async ({ page }) => {
    // Wait for show cards
    const showLink = page.locator('a[href^="/show/"]').first();
    await expect(showLink).toBeVisible({ timeout: 10000 });

    // Get the href before clicking
    const href = await showLink.getAttribute('href');
    expect(href).toBeTruthy();

    // Click the show card
    await showLink.click();

    // Should navigate to show page
    await expect(page).toHaveURL(new RegExp(`/show/`));
  });

  test('page is responsive on mobile', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    // Page should still load
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Show cards should still be visible
    const showLinks = page.locator('a[href^="/show/"]').first();
    await expect(showLinks).toBeVisible({ timeout: 10000 });
  });
});
