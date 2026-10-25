import { test, expect } from './helpers/test';

/**
 * Regression test for BRO-5419: static pages are built on one day and hydrated
 * on a later one. Client components that compute today-relative output during
 * render ("Just opened" -> "1 month Off-Broadway", a "Closing Soon" row that
 * drops a show overnight) made React throw a hydration error (#418), regenerate
 * the tree and lose the page's first clicks. That turned the filter-panel-sync
 * E2E red for every run between UTC midnight and the next deploy.
 *
 * The contract: a market page must hydrate cleanly when the viewer's clock is
 * well past the build time. Moving the browser clock forward simulates a visit
 * days or weeks after the build, so any render-time `new Date()` that changes
 * markup shows up here instead of as a dead filter button.
 */
const PAGES = ['/', '/off-broadway', '/west-end', '/off-west-end'];
const OFFSETS_DAYS = [1, 40];
const HYDRATION_ERROR = /Minified React error #(418|423|425)|Hydration failed|hydrat/i;

test.describe('Hydration survives a day change between build and visit', () => {
  for (const path of PAGES) {
    for (const days of OFFSETS_DAYS) {
      test(`${path} hydrates cleanly with the clock +${days}d`, async ({ page }) => {
        await page.clock.install({ time: new Date(Date.now() + days * 86400000) });
        const errors: string[] = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('console', m => {
          if (m.type() === 'error' && HYDRATION_ERROR.test(m.text())) errors.push(m.text());
        });
        await page.goto(path, { waitUntil: 'networkidle' });
        const hydration = errors.filter(e => HYDRATION_ERROR.test(e)).map(e => e.slice(0, 300));
        expect(hydration, `hydration errors on ${path} at +${days}d`).toEqual([]);
      });
    }
  }
});
