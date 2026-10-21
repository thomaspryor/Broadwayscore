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

/**
 * Outside the opening window, a full poll of one show runs at most this often
 * (BRO-5861). The orchestrator polls a 21-day lookback, and layers 1-3
 * (aggregators, RSS, site search) cost 2-5 min per show whatever pollMode says.
 * With 32 shows in the lookback the serial loop took ~2h and the job hit its
 * 145-min limit (run 39632362408). Reviews outside the window trickle in over
 * days, so a 6h floor costs little freshness; inside the window the backoff
 * gate is bypassed and every run still polls.
 */
const OUTSIDE_WINDOW_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Delay before the next full poll of `show`: the no-op backoff delay, raised to
 * the outside-window floor. The floor applies even after a run that found new
 * reviews; the gate ignores it while the show is in its opening window.
 */
function nextPollDelayMs(noOpDelayMs, show, now = new Date()) {
  if (isInOpeningWindow(show, now)) return noOpDelayMs;
  return Math.max(noOpDelayMs, OUTSIDE_WINDOW_MIN_INTERVAL_MS);
}

module.exports = { isInOpeningWindow, nextPollDelayMs, WINDOW_BEFORE_MS, WINDOW_AFTER_MS, OUTSIDE_WINDOW_MIN_INTERVAL_MS };
