/**
 * Clock-shift preload for time-bomb detection.
 *
 * Loaded via `node --import ./tests/helpers/clock-shift.mjs` (see
 * scripts/audit-time-bomb-tests.js). When BSC_CLOCK_SHIFT_DAYS is set to a
 * non-zero number, every subsequent `Date.now()` and argument-less `new Date()`
 * reports a time that many days in the future. Everything else about Date —
 * Date.parse, Date.UTC, explicit `new Date(x)` construction, instance methods —
 * is untouched, so only genuinely *now-relative* logic changes behaviour.
 *
 * WHY THIS EXISTS
 * A test that stamps a hardcoded literal (`clearedAt: '2026-08-04'`) and asserts
 * the code treats it as "fresh" passes on the day it is written and fails
 * silently N days later, where N is whatever rolling window the production code
 * uses. No commit causes the failure, so nothing in review, lint, or the test
 * suite itself can catch it — it detonates on a calendar date.
 *
 * On 2026-08-11 exactly this happened: two review-guards tests hardcoded
 * 2026-08-04 against review-write-guard.js's AUTO_CLEAR_FRESH_DAYS = 7 window.
 * They expired, and because main takes ~300 commits/day (90% of them bot data
 * commits, each triggering test.yml), the same two failures re-reported across
 * 160 consecutive red runs over 8 days.
 *
 * Running the suite under a forward clock shift surfaces this class before it
 * detonates: any test that passes at +0d and fails at +Nd is time-dependent by
 * construction. Fix by making the stamp relative to run time
 * (`daysAgoISO(1)`), not by widening the assertion.
 */

const SHIFT_DAYS = Number(process.env.BSC_CLOCK_SHIFT_DAYS || 0);

if (Number.isFinite(SHIFT_DAYS) && SHIFT_DAYS !== 0) {
  const SHIFT_MS = SHIFT_DAYS * 86400000;
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);

  // Subclassing preserves Date.parse / Date.UTC / prototype methods via normal
  // static+prototype inheritance, so only the two now-relative entry points
  // (argument-less construction and Date.now) are redirected.
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(realNow() + SHIFT_MS);
      } else {
        super(...args);
      }
    }

    static now() {
      return realNow() + SHIFT_MS;
    }
  }

  Object.defineProperty(ShiftedDate, 'name', { value: 'Date' });
  globalThis.Date = ShiftedDate;
}
