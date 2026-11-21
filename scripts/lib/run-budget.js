'use strict';
/**
 * Wall-clock run budget for cron scripts that walk unbounded backlogs.
 *
 * The weekly scraper crons (recover-explicit-ratings, deep-research-commercial,
 * scrape-westendtheatre-roundups) process work lists that grow over time. A
 * GitHub Actions `timeout-minutes` kill is a SIGKILL mid-item: the run goes red,
 * notify-failure fires, and `if: always()` cleanup steps race a ~5 min grace
 * window. A run budget lets the script stop cleanly BEFORE the workflow
 * timeout, report how much backlog remains, and exit 0 — the workflow timeout
 * stays as a backstop, not the cap.
 *
 * Usage:
 *   const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
 *   const budget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));
 *   for (const item of backlog) {
 *     if (budget.exceeded()) break;  // log remaining, then break
 *     ...
 *   }
 *
 * Near-deadline overrun (BRO-2303, BRO-3340): exceeded() only says the
 * budget is ALREADY gone. An item that starts with 30s left still runs its
 * full worst case (a fetchPage() chain can take ~2.5 min: Scrapingdog/Bright
 * Data/ScrapingBee timeouts plus the 90s Playwright tier deadline), which can
 * carry the step past its timeout-minutes when the gap between
 * --time-budget-min and that timeout is smaller than one item. Where it is,
 * check at the loop head with the item's worst case instead:
 *
 *   if (!budget.canStartItem(MIN_REMAINING_MS_TO_START)) break;
 *
 * and justify MIN_REMAINING_MS_TO_START next to its definition (worst item
 * cost minus the slack the workflow leaves).
 */

/**
 * Parse `--time-budget-min=N` from an argv array. Returns 0 (disabled) when
 * the flag is absent, malformed, or non-positive.
 */
function parseTimeBudgetMin(argv, flagName = '--time-budget-min') {
  const raw = (argv || []).find(a => typeof a === 'string' && a.startsWith(flagName + '='));
  if (!raw) return 0;
  const n = parseFloat(raw.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Create a budget tracker. `minutes <= 0` disables it (exceeded() is always
 * false). `now` is injectable for tests.
 */
function createRunBudget(minutes, now = Date.now) {
  const startedAt = now();
  const enabled = Number.isFinite(minutes) && minutes > 0;
  const budgetMs = enabled ? minutes * 60_000 : Infinity;
  return {
    minutes: enabled ? minutes : 0,
    enabled,
    elapsedMs: () => now() - startedAt,
    elapsedMin: () => Math.round((now() - startedAt) / 60_000),
    remainingMs: () => (enabled ? Math.max(0, budgetMs - (now() - startedAt)) : Infinity),
    exceeded: () => enabled && now() - startedAt >= budgetMs,
    // False once the budget is spent OR less than `minRemainingMs` is left.
    // A disabled budget always allows the next item (same as exceeded()).
    canStartItem: (minRemainingMs = 0) => {
      if (!enabled) return true;
      const remaining = Math.max(0, budgetMs - (now() - startedAt));
      if (remaining <= 0) return false;
      // Infinity is an impossible reserve: never start (BRO-5261; it used to
      // read as 0 and always start). NaN / negative still mean "no reserve".
      if (minRemainingMs === Infinity) return false;
      return remaining >= (Number.isFinite(minRemainingMs) && minRemainingMs > 0 ? minRemainingMs : 0);
    },
  };
}

/**
 * Cumulative per-phase deadlines for a multi-phase run (BRO-7928).
 *
 * recover-explicit-ratings.js runs phase 0 (SERP URL discovery, slow, one
 * search per review) before phases 1-3 (local text, free APIs, scraping). On
 * the weekly cron phase 0 used all 100 minutes three weeks running
 * (2026-11-01/08/15) and every run recovered 0 ratings: the cheap phases never
 * started. A deadline per phase caps the slow one without wasting time: each
 * share is cumulative (phase 0 must stop by 30% of the budget, phase 1 by
 * 55%, ...), so time a phase leaves unused rolls forward to the next.
 *
 * phaseDeadlineReached(budget, shares, phase) -> true once the run has spent
 * shares[phase] of its budget. A disabled budget, or a phase with no share,
 * never hits a deadline (the run-wide exceeded() still applies).
 */
function phaseDeadlineReached(budget, shares, phase) {
  if (!budget || !budget.enabled) return false;
  const share = shares && shares[phase];
  if (!Number.isFinite(share) || share <= 0) return false;
  // Rounded: 0.55 * 100 min in floating point is a hair over 55 min.
  return budget.elapsedMs() >= Math.round(Math.min(1, share) * budget.minutes * 60_000);
}

module.exports = { parseTimeBudgetMin, createRunBudget, phaseDeadlineReached };
