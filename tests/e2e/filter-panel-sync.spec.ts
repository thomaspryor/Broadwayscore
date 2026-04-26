import { test, expect, Page } from '@playwright/test';

/**
 * Filter panel ↔ inline ToggleBar sync regression guard.
 *
 * Background: 2026-04-26 ship-check found two P0 sync bugs that would have
 * shipped silently. tsc + lint + visual QA all passed; the bug only manifests
 * on user interaction. See:
 *   - memory/feedback_url_state_multi_writer.md
 *   - memory/feedback_react_searchparams_stale.md
 *   - memory/feedback_clearall_two_writer_race.md
 *
 * What this test guards:
 *   1. Tap panel pill → URL updates, list re-filters, inline pill highlights
 *   2. Tap inline pill → URL updates, panel chip + badge appear
 *   3. Click "Clear all" → URL empty, no chips, defaults restored, NO race
 *      (no stale params left in URL)
 *
 * Runs on all 4 list pages — Broadway uses CLOSING status, the others use
 * PREVIEWS, so per-page wiring of singleGroups is exercised.
 *
 * Run locally against dev server:
 *   TEST_BASE_URL=http://localhost:3000 npx playwright test --project=chromium tests/e2e/filter-panel-sync.spec.ts
 *
 * In CI, runs against TEST_BASE_URL (defaults to https://broadwayscorecard.com).
 */

interface PageConfig {
  path: string;
  name: string;
  /** Status pill that exists ONLY on this market (Broadway has CLOSING; OB/WE/OffWE have PREVIEWS). */
  uniqueStatusLabel: 'CLOSING' | 'PREVIEWS';
  uniqueStatusParamValue: 'closing_soon' | 'previews';
}

const PAGES: PageConfig[] = [
  { path: '/', name: 'Broadway', uniqueStatusLabel: 'CLOSING', uniqueStatusParamValue: 'closing_soon' },
  { path: '/off-broadway', name: 'Off-Broadway', uniqueStatusLabel: 'PREVIEWS', uniqueStatusParamValue: 'previews' },
  { path: '/west-end', name: 'West End', uniqueStatusLabel: 'PREVIEWS', uniqueStatusParamValue: 'previews' },
  { path: '/off-west-end', name: 'Off-West-End', uniqueStatusLabel: 'PREVIEWS', uniqueStatusParamValue: 'previews' },
];

/**
 * Click a button by exact text content, optionally restricted to the panel
 * dialog or to elements outside it. Avoids strict-mode violations when the
 * same label exists in both the panel and inline (e.g. "Plays").
 */
async function clickButton(page: Page, label: string, scope: 'inline' | 'panel') {
  return await page.evaluate(({ label, scope }) => {
    const btns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const target = btns.find((b) => {
      const text = (b.textContent || '').trim();
      if (text !== label) return false;
      const inDialog = !!b.closest('[role="dialog"]');
      return scope === 'panel' ? inDialog : !inDialog;
    });
    if (!target) return false;
    target.click();
    return true;
  }, { label, scope });
}

async function readPanelState(page: Page) {
  return await page.evaluate(() => {
    const inlinePressed = (label: string): string | null => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => (b.textContent || '').trim() === label && !b.closest('[role="dialog"]'),
      ) as HTMLButtonElement | undefined;
      return btn?.getAttribute('aria-pressed') ?? null;
    };
    const chips = Array.from(document.querySelectorAll('button[aria-label^="Remove "]'))
      .map((b) => b.getAttribute('aria-label')?.replace(/^Remove /, '') ?? '');
    // FilterButton's aria-label flips between "Open filters" (idle) and
    // "Filters (N active)" (when count > 0). Match either.
    const filterBtn = (document.querySelector('button[aria-label="Open filters"]')
      ?? document.querySelector('button[aria-label^="Filters ("]')) as HTMLButtonElement | null;
    const badgeText = filterBtn?.textContent?.trim() ?? '';
    const filterAriaLabel = filterBtn?.getAttribute('aria-label') ?? '';
    return {
      url: window.location.search,
      inlineAllPressed: inlinePressed('All'),
      inlineMusicalsPressed: inlinePressed('Musicals'),
      inlinePlaysPressed: inlinePressed('Plays'),
      inlinePlayingPressed: inlinePressed('PLAYING'),
      chips,
      badgeText,
      filterAriaLabel,
    };
  });
}

for (const cfg of PAGES) {
  test.describe(`Filter panel sync — ${cfg.name} (${cfg.path})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(cfg.path);
      // Let inline filters hydrate before interacting
      await page.waitForLoadState('networkidle');
    });

    test('panel → inline: tapping Plays in panel highlights inline Plays + writes ?type=play', async ({ page }) => {
      // Open the filter panel
      const opened = await clickButton(page, 'Open filters', 'inline');
      // Filter button uses aria-label, so the inline scope click might not match.
      // Fall back to direct selector.
      if (!opened) {
        await page.locator('button[aria-label="Open filters"]').click();
      }
      await page.locator('[role="dialog"]').waitFor({ state: 'visible' });

      // Click Plays inside the panel
      const clicked = await clickButton(page, 'Plays', 'panel');
      expect(clicked).toBe(true);

      // Wait for state to settle (router transition + React update)
      await page.waitForFunction(() => window.location.search.includes('type=play'), null, { timeout: 5000 });

      // URL reflects the change
      expect(new URL(page.url()).searchParams.get('type')).toBe('play');

      // Inline Plays pill is now pressed (the proof of cross-component sync)
      // Note: the inline ToggleBar may not be visible while the panel is open
      // on mobile (panel covers it), but aria-pressed is still queryable.
      const playsPressed = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(
          (b) => (b.textContent || '').trim() === 'Plays' && !b.closest('[role="dialog"]'),
        ) as HTMLButtonElement | undefined;
        return btn?.getAttribute('aria-pressed');
      });
      expect(playsPressed).toBe('true');
    });

    test('inline → panel: tapping inline Musicals shows Type chip + badge in panel', async ({ page }) => {
      // Click the inline Musicals pill (outside the panel)
      const clicked = await clickButton(page, 'Musicals', 'inline');
      expect(clicked).toBe(true);

      await page.waitForFunction(() => window.location.search.includes('type=musical'), null, { timeout: 5000 });

      const state = await readPanelState(page);
      expect(state.url).toContain('type=musical');
      expect(state.chips).toContain('Type: Musicals');
      // Badge: aria-label flips to "Filters (1 active)" when count > 0
      expect(state.filterAriaLabel).toMatch(/Filters \(\d+ active\)/);
      expect(state.inlineMusicalsPressed).toBe('true');
    });

    test('clear all: removes type/status from URL with NO regression race', async ({ page }) => {
      // Stage URL with multiple params (multi-select + single-select)
      await page.goto(`${cfg.path}?type=musical&status=${cfg.uniqueStatusParamValue}&production=original`);
      await page.waitForLoadState('networkidle');

      // Sanity: chips render before clear
      const before = await readPanelState(page);
      expect(before.chips.length).toBeGreaterThanOrEqual(2);

      // Instrument history.replaceState to detect race (regressed keys after delete)
      const trace = await page.evaluate(() => {
        const log: string[] = [];
        const orig = history.replaceState;
        history.replaceState = function (...args: unknown[]) {
          log.push(String(args[2] ?? ''));
          return orig.apply(this, args as Parameters<typeof history.replaceState>);
        };
        const clearAll = Array.from(document.querySelectorAll('button')).find(
          (b) => (b.textContent || '').trim() === 'Clear all',
        ) as HTMLButtonElement | undefined;
        clearAll?.click();
        return new Promise<{ writes: string[]; finalUrl: string }>((resolve) => {
          setTimeout(() => {
            history.replaceState = orig;
            resolve({ writes: log, finalUrl: window.location.search });
          }, 600);
        });
      });

      // Final URL is clean (no panel keys)
      const finalParams = new URLSearchParams(trace.finalUrl);
      expect(finalParams.get('type')).toBeNull();
      expect(finalParams.get('status')).toBeNull();
      expect(finalParams.get('production')).toBeNull();
      expect(finalParams.get('years')).toBeNull();

      // Race detector: NO replaceState write should re-introduce a panel key
      // after it was deleted. The historical bug pattern: writes ended with
      // `/?production=original` even though earlier writes had cleaned it.
      const lastWrite = trace.writes[trace.writes.length - 1] ?? '';
      const lastSearch = lastWrite.includes('?') ? lastWrite.slice(lastWrite.indexOf('?') + 1) : '';
      const lastParams = new URLSearchParams(lastSearch);
      expect(lastParams.get('type'), 'last write must not contain type').toBeNull();
      expect(lastParams.get('status'), 'last write must not contain status').toBeNull();
      expect(lastParams.get('production'), 'last write must not contain production').toBeNull();

      // Inline state also reset
      const after = await readPanelState(page);
      expect(after.chips).toHaveLength(0);
      // Badge gone: aria-label reverts to "Open filters" (no count suffix)
      expect(after.filterAriaLabel).toBe('Open filters');
      expect(after.inlineAllPressed).toBe('true');
      expect(after.inlinePlayingPressed).toBe('true');
    });
  });
}
