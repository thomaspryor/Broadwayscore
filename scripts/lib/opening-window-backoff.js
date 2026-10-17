/**
 * opening-window-backoff — pure predicate for the poller's aggressive-window
 * carve-out (Balusters postmortem CLASS 7 backoff, scripts/opening-night-poller.js).
 *
 * Card #1314: the old carve-out was only [openingDate, openingDate+6h). Quiet
 * previews train consecutiveNoOp up to 20+, pushing nextRunAfter hours out —
 * and reviews routinely land AFTER that 6h window (Death Note: opened
 * 2026-08-11, first reviews 2026-08-12 ~24h later), so the backoff was still
 * active and suppressed cadence on the exact morning reviews dropped.
 * Widened to [openingDate-1d, openingDate+3d] to cover press-embargo slip and
 * the T2/T3 morning-after-the-morning-after tail.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_BEFORE_MS = ONE_DAY_MS;
const WINDOW_AFTER_MS = 3 * ONE_DAY_MS;

/**
 * Whether `show` is inside its opening-window backoff carve-out at `now`.
 * A MISSING openingDate means we can't bound the window — treat as
 * always-aggressive (matches the pre-#1314 behavior for shows lacking a
 * known opening date). A PRESENT but unparseable openingDate fails closed
 * (not in window, normal backoff applies) — also matching pre-#1314
 * behavior, where NaN date-math made the old hoursSinceOpening comparison
 * false. Fail-open here would let a data-quality bug (garbage openingDate)
 * silently disable backoff forever instead of surfacing as a data problem.
 */
function isInOpeningWindow(show, now = new Date()) {
  if (!show || !show.openingDate) return true;
  const opening = new Date(show.openingDate).getTime();
  if (Number.isNaN(opening)) return false;
  const nowMs = now instanceof Date ? now.getTime() : now;
  return nowMs >= opening - WINDOW_BEFORE_MS && nowMs <= opening + WINDOW_AFTER_MS;
}

module.exports = { isInOpeningWindow, WINDOW_BEFORE_MS, WINDOW_AFTER_MS };
