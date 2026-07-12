import { test, expect, type Page } from '@playwright/test';
import { assertNoHorizontalOverflow } from './helpers/layout-assertions';
import { VIEWPORTS } from './helpers/mock-helpers';

/**
 * Functional E2E tests for RatingEditor — the shared rating editor that replaced
 * the redesign's locked-5.0 "Rate it" panel.
 *
 * Uses /test/rating-editor-fixture with local-state callbacks (no Supabase/auth).
 * Run: TEST_BASE_URL=http://localhost:3456 npx playwright test --project=chromium tests/e2e/rating-editor.spec.ts
 */

/** Today (viewer-local) as YYYY-MM-DD — mirrors RatingEditor.localToday(). */
function localToday(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split('T')[0];
}

async function goToEditor(page: Page, query = ''): Promise<void> {
  await page.goto(`/test/rating-editor-fixture${query}`);
  await page.waitForSelector('[data-testid="rating-editor-fixture"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="rating-editor"]', { timeout: 30000 });
}

for (const vp of VIEWPORTS) {
  test.describe(`RatingEditor — ${vp.name} (${vp.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
    });

    test('no horizontal overflow with editor open', async ({ page }) => {
      await goToEditor(page);
      await assertNoHorizontalOverflow(page);
    });

    test('stars are adjustable inside the editor', async ({ page }) => {
      await goToEditor(page);
      const editor = page.locator('[data-testid="rating-editor"]');

      // Full star — click the right side of the 3rd star.
      await editor.getByRole('button', { name: '3 stars' }).click({ position: { x: 30, y: 20 } });
      await expect(editor.getByText('3.0', { exact: true })).toBeVisible();

      // Half star — click the left side of the 4th star.
      await editor.getByRole('button', { name: '4 stars' }).click({ position: { x: 4, y: 20 } });
      await expect(editor.getByText('3.5', { exact: true })).toBeVisible();
    });

    test('save persists the adjusted rating', async ({ page }) => {
      await goToEditor(page);
      const editor = page.locator('[data-testid="rating-editor"]');
      await editor.getByRole('button', { name: '4 stars' }).click();
      await page.getByRole('button', { name: /^save$/i }).click();

      // Editor closes; saved value reflects the adjusted rating.
      await expect(page.locator('[data-testid="rating-editor"]')).not.toBeVisible({ timeout: 3000 });
      await expect(page.locator('[data-testid="last-saved"]')).toContainText('saved:4:');
    });

    test('failed save keeps the panel open with the typed note intact', async ({ page }) => {
      await goToEditor(page, '?fail=1');
      const editor = page.locator('[data-testid="rating-editor"]');
      await editor.getByRole('button', { name: '4 stars' }).click();
      await page.locator('textarea').fill('Loved the second act.');

      await page.getByRole('button', { name: /^save$/i }).click();

      // Editor stays open, error is shown, and the note is NOT lost.
      await expect(editor).toBeVisible();
      await expect(editor.getByRole('alert')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('textarea')).toHaveValue('Loved the second act.');
      await expect(page.getByRole('button', { name: /retry/i })).toBeVisible();
    });

    test('date defaults to today for a new rating', async ({ page }) => {
      await goToEditor(page);
      await expect(page.locator('input[type="date"]')).toHaveValue(localToday());
    });

    test('date is capped to the closing date when the show has closed', async ({ page }) => {
      await goToEditor(page, '?closing=2020-01-01');
      // closing (2020) is before today → max is the closing date.
      await expect(page.locator('input[type="date"]')).toHaveAttribute('max', '2020-01-01');
    });

    test('modal presentation escapes .card containment — Save reachable', async ({ page }) => {
      // Regression: .card sets `contain: layout style`, which traps position:fixed
      // descendants; before the Modal portal fix, the bottom sheet rendered inside
      // the card and the Save button landed below the fold on phones (2026-07-05).
      await goToEditor(page, '?presentation=modal');

      // Dialog must be a direct child of <body> (portal), not nested in the card.
      const parentTag = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"][aria-label^="Rate"]');
        return dlg?.parentElement?.tagName ?? 'MISSING';
      });
      expect(parentTag).toBe('BODY');

      // Save must be fully inside the viewport and clickable.
      const editor = page.locator('[data-testid="rating-editor"]');
      await editor.getByRole('button', { name: '4 stars' }).click({ position: { x: 30, y: 20 } });
      const saveBtn = page.getByRole('button', { name: /^save$/i });
      const box = await saveBtn.boundingBox();
      const viewport = page.viewportSize()!;
      expect(box).not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      await saveBtn.click({ timeout: 5000 });
      await expect(page.locator('[data-testid="last-saved"]')).toContainText('saved:4:');
    });

    test('stacked modals: Escape closes only the topmost, editor draft survives', async ({ page }) => {
      // Regression (2026-07-11): a module-level modal stack was split-brain across
      // webpack chunks, so Escape closed BOTH the sign-in modal and the rating
      // editor beneath it, discarding the draft. Topmost-ness now comes from DOM
      // order. This renders the editor as a Modal with a second Modal stacked on top.
      await goToEditor(page, '?presentation=modal&stack=1');
      const editor = page.locator('[data-testid="rating-editor"]');
      const stacked = page.locator('[data-testid="stacked-modal"]');
      await expect(stacked).toBeVisible();

      await page.locator('textarea').fill('draft must survive');
      await page.keyboard.press('Escape');
      await expect(stacked).not.toBeVisible({ timeout: 3000 });
      await expect(editor).toBeVisible();
      await expect(page.locator('textarea')).toHaveValue('draft must survive');

      // Second Escape now closes the editor (it is topmost).
      await page.keyboard.press('Escape');
      await expect(editor).not.toBeVisible({ timeout: 3000 });
    });

    test('auth-gated save then Escape: only the top modal closes, draft survives', async ({ page }) => {
      // Reproduces the production listener-order bug (2026-07-11): Save toggles
      // the editor's `saving` state, re-attaching its Escape listener AFTER the
      // stacked modal's. React 18 flushes the top modal's close between native
      // listeners, so without event-claiming the editor then saw itself as
      // topmost and closed too, discarding the draft.
      await goToEditor(page, '?presentation=modal&authgate=1');
      const editor = page.locator('[data-testid="rating-editor"]');
      const stacked = page.locator('[data-testid="stacked-modal"]');

      await editor.getByRole('button', { name: '4 stars' }).click({ position: { x: 30, y: 20 } });
      await page.locator('textarea').fill('gated draft');
      await page.getByRole('button', { name: /^save$/i }).click();
      await expect(stacked).toBeVisible({ timeout: 3000 });
      await expect(editor).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(stacked).not.toBeVisible({ timeout: 3000 });
      await expect(editor).toBeVisible();
      await expect(page.locator('textarea')).toHaveValue('gated draft');

      await page.keyboard.press('Escape');
      await expect(editor).not.toBeVisible({ timeout: 3000 });
    });

    test('edit state pre-fills note/date and round-trips the reviewId', async ({ page }) => {
      await goToEditor(page, '?state=edit');
      const editor = page.locator('[data-testid="rating-editor"]');
      await expect(editor.getByText('4.5', { exact: true })).toBeVisible();
      await expect(page.locator('textarea')).toHaveValue('Incredible show!');
      await expect(page.locator('input[type="date"]')).toHaveValue('2024-11-15');

      await page.getByRole('button', { name: /^save$/i }).click();
      await expect(page.locator('[data-testid="last-saved"]')).toContainText('saved:4.5:Incredible show!:2024-11-15:r1');
    });
  });
}
