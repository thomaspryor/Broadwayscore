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

    // Show cards are present (not an empty page or error boundary)
    const showLinks = page.locator('a[href^="/show/"]');
    await expect(showLinks.first()).toBeVisible({ timeout: 15000 });
    const count = await showLinks.count();
    expect(count).toBeGreaterThan(5);

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
});
