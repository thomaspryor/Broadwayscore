import { test, expect } from './helpers/test';
import type { Page, Route } from '@playwright/test';

/**
 * BRO-7494: the show page's rating editor is a lazy chunk (BRO-7486). This spec
 * proves the three guards against a real build:
 *  1. a failed chunk download shows a toast and closes the panel; the show page
 *     stays (no src/app/error.tsx takeover), and the next tap retries and works;
 *  2. a slow chunk shows a skeleton about the editor's height (no blank tap,
 *     no collapse-then-jump);
 *  3. pointerdown/hover on "Rate it" starts the download before the click.
 *
 * Run against a local build of this branch (signed out; userAccounts flag on):
 *   TEST_BASE_URL=http://localhost:3456 SHOW_SLUG=the-lost-boys \
 *     npx playwright test --project=chromium tests/e2e/lazy-panel-guard.spec.ts --trace off
 */

const SLUG = process.env.SHOW_SLUG || 'the-lost-boys';
const CHUNK_RE = /\/_next\/static\/chunks\/.+\.js(\?.*)?$/;

async function openShow(page: Page): Promise<void> {
  await page.goto(`/show/${SLUG}`, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('hero-action-cluster')).toBeVisible();
}

const rateButton = (page: Page) => page.getByTestId('hero-action-cluster').getByRole('button', { name: /^(rate it|log another viewing)$/i });

test.describe('lazy rating editor guards (desktop)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('failed chunk: toast, panel closed, page intact, retry works', async ({ page }) => {
    await openShow(page);
    // Every chunk requested from now on fails: the editor's chunk is the only new one.
    const fail = (route: Route) => route.abort('failed');
    await page.route(CHUNK_RE, fail);
    await rateButton(page).click();

    await expect(page.getByText(/couldn.t open that/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('rating-editor')).toHaveCount(0);
    await expect(page.getByTestId('rating-editor-skeleton')).toHaveCount(0);
    await expect(page.getByTestId('hero-action-cluster')).toBeVisible();
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);

    await page.unroute(CHUNK_RE, fail);
    await rateButton(page).click();
    await expect(page.getByTestId('rating-editor')).toBeVisible({ timeout: 15000 });
  });

  test('slow chunk: skeleton first, about the editor height', async ({ page }) => {
    await openShow(page);
    await page.route(CHUNK_RE, async (route) => {
      await new Promise(r => setTimeout(r, 1500));
      await route.continue();
    });
    await rateButton(page).click();

    const skeleton = page.getByTestId('rating-editor-skeleton');
    await expect(skeleton).toBeVisible();
    const skeletonH = (await skeleton.boundingBox())!.height;

    await expect(page.getByTestId('rating-editor')).toBeVisible({ timeout: 15000 });
    await expect(skeleton).toHaveCount(0);
    // The editor's inline card is the rating-editor element's parent.
    const editorH = await page.getByTestId('rating-editor').evaluate(el => el.parentElement!.getBoundingClientRect().height);
    console.log(`skeleton ${skeletonH.toFixed(0)}px, editor ${editorH.toFixed(0)}px`);
    expect(Math.abs(skeletonH - editorH)).toBeLessThanOrEqual(24);
  });

  test('hover on Rate it preloads the chunk before the click', async ({ page }) => {
    await openShow(page);
    const requested: string[] = [];
    page.on('request', req => { if (CHUNK_RE.test(req.url())) requested.push(req.url()); });
    await rateButton(page).hover();
    await expect.poll(() => requested.length, { timeout: 5000 }).toBeGreaterThan(0);
  });
});

test.describe('lazy rating editor guards (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('slow chunk: sheet skeleton, then the editor sheet', async ({ page }) => {
    await openShow(page);
    await page.route(CHUNK_RE, async (route) => {
      await new Promise(r => setTimeout(r, 1500));
      await route.continue();
    });
    // Phones rate from the tap-to-rate star row (first rating) or the button.
    const star = page.getByRole('button', { name: '4 stars' }).first();
    if (await star.isVisible()) await star.tap(); else await rateButton(page).tap();

    const sheet = page.getByTestId('rating-editor-skeleton-sheet');
    await expect(sheet).toBeVisible();
    // Anchored to the screen (not trapped in the hero card) and about the editor sheet's height.
    const skelTop = (await sheet.locator('> div').last().boundingBox())!.y;
    await expect(page.getByTestId('rating-editor')).toBeVisible({ timeout: 15000 });
    await expect(sheet).toHaveCount(0);
    const realTop = (await page.getByRole('dialog').locator('> div').last().boundingBox())!.y;
    console.log(`phone sheet top: skeleton ${skelTop.toFixed(0)}px, editor ${realTop.toFixed(0)}px`);
    expect(Math.abs(skelTop - realTop)).toBeLessThanOrEqual(24);
  });
});
