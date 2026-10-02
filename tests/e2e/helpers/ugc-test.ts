import { test as base, expect } from '@playwright/test';

/**
 * `test` for every spec that renders My Shows mock data (`/my-shows?mock=1`)
 * or the UGC fixture pages. Import it instead of `@playwright/test`'s.
 *
 * Why: src/app/my-shows/__dev-mock-data.ts has absolute dates (a watchlist row
 * booked for 2026-09-15, others "to be rated" from February). The page buckets
 * rows against the browser's real "today", so on 2026-09-16 the Sep 15 booking
 * silently moved from Upcoming to To Be Rated and every watchlist assertion
 * and baseline went red. Pinning "now" makes these specs mean the same thing
 * on every day they run. tests/unit/ugc-e2e-clock-pin.test.mjs fails if a spec
 * that renders mock data stops importing this.
 *
 * clock.install (not setFixedTime): time still flows from MOCK_NOW, so code
 * that measures elapsed time with Date.now() (debounces, toasts) keeps working.
 */
export const MOCK_NOW = '2026-09-01T16:00:00Z';
/** MOCK_NOW as the YYYY-MM-DD a date input shows (16:00Z is Sep 1 in every US zone). */
export const MOCK_TODAY = '2026-09-01';

export const test = base.extend<{ pinnedClock: void }>({
  pinnedClock: [
    async ({ page }, use) => {
      await page.clock.install({ time: new Date(MOCK_NOW) });
      await use();
    },
    { auto: true },
  ],
});

export { expect };
