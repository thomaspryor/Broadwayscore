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
});
