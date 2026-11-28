import { test, expect } from './helpers/test';
import { freezeLiveShowData } from './helpers/freeze-live-data';

/**
 * Visual regression tests for layout-critical UI regions.
 * Uses /show/hamilton (stable, long-running show) for consistent baselines.
 *
 * The show page renders ShowHeroRedesign since showPageRedesign launched with
 * userAccounts (2026-10-02, BRO-4525); the legacy show-header-card only renders
 * with the flag off, so the header test targets the redesign hero.
 *
 * These run against production (push-time E2E job), so every test pins the
 * live, mutable show data in its region with freezeLiveShowData() before the
 * screenshot (BRO-7649: a regenerated Critics' Take turned main red with no
 * code change). tests/unit/visual-baseline-stable-data.test.mjs enforces it.
 *
 * To update baselines: gh workflow run "Test Suite" -f test_type=visual-only -f update_snapshots=true
 */

const SHOW_URL = '/show/hamilton';
const HERO = '[data-testid="show-hero-redesign"]';

test.describe('Visual Regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(SHOW_URL);
    await page.waitForSelector(HERO);
    // TicketButtonsAB renders nothing until PostHog A/B flags load (5s
    // fallback), leaving the hero shorter until the ticket CTA appears. Wait
    // for the CTA so screenshots always capture the settled state. catch()
    // keeps this from failing if the show has no ticket links; note it also
    // masks selector breakage (e.g. CTA copy change), which would silently
    // degrade back to the original flake rather than error here.
    await page
      .locator(HERO)
      .getByText('Get Tickets')
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => {});
  });

  test('show hero layout', async ({ page }) => {
    const hero = page.locator(HERO);
    await freezeLiveShowData(page, HERO, { requireCriticsTake: true });
    await expect(hero).toHaveScreenshot('show-hero-redesign.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('meta line wrapping', async ({ page }) => {
    const metaLine = page.locator('[data-testid="show-meta-line"]');
    await freezeLiveShowData(page, '[data-testid="show-meta-line"]');
    await expect(metaLine).toHaveScreenshot('show-meta-line.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('review card alignment', async ({ page }) => {
    const reviewCard = page.locator('[data-testid="review-card"]').first();
    await freezeLiveShowData(page, '[data-testid="review-card"]', { pinLongText: true });
    await expect(reviewCard).toHaveScreenshot('review-card.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});
