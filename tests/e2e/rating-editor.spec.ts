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

    test('late-arriving suggested date (watchlist planned date) replaces the untouched default', async ({ page }) => {
      // Regression: ?rate=1 opens the editor before the watchlist fetch
      // resolves, so the diary's "Saw Jun 24" date arrived after mount and the
      // field stayed on today (owner report, 2026-07-17).
      await goToEditor(page, '?suggestDelayed=2026-06-24');
      await expect(page.locator('input[type="date"]')).toHaveValue(localToday());
      await expect(page.locator('input[type="date"]')).toHaveValue('2026-06-24', { timeout: 5000 });
      await expect(page.getByTestId('date-seen-display')).toContainText('Jun 24, 2026');
    });

    test('late suggestion never clobbers a date the user already cleared', async ({ page }) => {
      await goToEditor(page, '?suggestDelayed=2026-06-24');
      // User interacts with the date field (clears it) BEFORE the suggestion lands.
      await page.getByRole('button', { name: 'Clear date' }).click();
      await expect(page.locator('input[type="date"]')).toHaveValue('');
      await page.waitForTimeout(1500);
      await expect(page.locator('input[type="date"]')).toHaveValue('');
    });

    test('date max is today — never the closing date (closed shows stay pickable)', async ({ page }) => {
      // Regression: capping at closingDate anchored the native picker years in
      // the past and read as locked (La Cage aux Folles, 2026-07-13).
      await goToEditor(page);
      await expect(page.locator('input[type="date"]')).toHaveAttribute('max', localToday());
    });

    test('date control is a button — nothing focusable for password managers', async ({ page }) => {
      // Regression: managers ignored data-1p-ignore on the visible date input
      // and popped autofill over the picker (2026-07-13). The real input must
      // be untabbable/hidden; the user-facing control is a plain button.
      await goToEditor(page);
      const dateInput = page.locator('input[type="date"]');
      await expect(dateInput).toHaveAttribute('tabindex', '-1');
      await expect(dateInput).toHaveAttribute('aria-hidden', 'true');
      const trigger = page.getByRole('button', { name: 'Date seen' });
      await expect(trigger).toBeVisible();
      // Clear ✕ empties the value; trigger falls back to placeholder copy.
      await page.getByRole('button', { name: 'Clear date' }).click();
      await expect(dateInput).toHaveValue('');
      await expect(trigger).toContainText('Add a date');
    });

    test('hovering star halves previews the exact value in the number', async ({ page }) => {
      // Regression: production registered left-half hovers as whole stars and
      // gave no feedback on what a click would commit (2026-07-13).
      await goToEditor(page);
      const editor = page.locator('[data-testid="rating-editor"]');
      const star3 = editor.getByRole('button', { name: '3 stars' });
      const box = (await star3.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
      await expect(editor.locator('[data-testid="rating-value"]')).toHaveText('2.5');
      await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
      await expect(editor.locator('[data-testid="rating-value"]')).toHaveText('3.0');
      // Click commits the previewed half value.
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.up();
      await expect(editor.locator('[data-testid="rating-value"]')).toHaveText('2.5');
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

    test('modal traps focus — Tab cycles within the editor, not the page behind', async ({ page }) => {
      await goToEditor(page, '?presentation=modal');
      // Focus starts inside the modal.
      const inModal = () => page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"][aria-modal="true"]');
        return !!dlg && dlg.contains(document.activeElement);
      });
      await expect.poll(inModal).toBe(true);
      // Tab many times; focus must never escape the modal.
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        expect(await inModal()).toBe(true);
      }
    });

    test('keyboard: arrow keys adjust rating in half-star steps', async ({ page }) => {
      await goToEditor(page);
      const editor = page.locator('[data-testid="rating-editor"]');
      await editor.getByRole('button', { name: '1 star' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(editor.getByText('0.5', { exact: true })).toBeVisible();
      await page.keyboard.press('ArrowRight');
      await expect(editor.getByText('1.0', { exact: true })).toBeVisible();
      await page.keyboard.press('ArrowLeft');
      await expect(editor.getByText('0.5', { exact: true })).toBeVisible();
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
