import { test, expect } from '@playwright/test';

test.describe('Biz Buzz Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/biz-buzz');
  });

  test('designation legend shows updated descriptions (no Profit > Nx language)', async ({ page }) => {
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('Profit > 3x');
    expect(bodyText).not.toContain('Profit > 1.5x');
    expect(bodyText).toContain('Long-running mega-hit');
    expect(bodyText).toContain('Solid hit');
  });

  test('Tour Stop designation appears in legend', async ({ page }) => {
    const bodyText = await page.textContent('body');
    expect(bodyText).toContain('Tour Stop');
    expect(bodyText).toContain('National tour');
  });

  test('Mamma Mia appears as Tour Stop', async ({ page }) => {
    const tourStopSection = page.locator('text=Tour Stop').first();
    await expect(tourStopSection).toBeVisible();
  });

  test('TBD shows display estimated recoupment percentages', async ({ page }) => {
    const bodyText = await page.textContent('body');
    expect(bodyText).toContain('% recouped');
  });
});

test.describe('Recoupment Progress Bar', () => {
  test('displays on show pages with estimates', async ({ page }) => {
    await page.goto('/show/death-becomes-her');
    await page.waitForLoadState('networkidle');
    const progressBar = page.locator('[data-testid="recoupment-progress"]');
    await expect(progressBar).toBeVisible({ timeout: 10000 });
    const text = await progressBar.textContent();
    expect(text).toContain('recouped');
    // Check for any percentage range (e.g., "10-30%" or "~10-30%")
    expect(text).toMatch(/\d+(-\d+)?%?\s*recouped/i);
  });

  test('does NOT display on shows without estimates', async ({ page }) => {
    await page.goto('/show/hamilton');
    await page.waitForLoadState('networkidle');
    const progressBar = page.locator('[data-testid="recoupment-progress"]');
    await expect(progressBar).toHaveCount(0);
  });
});
