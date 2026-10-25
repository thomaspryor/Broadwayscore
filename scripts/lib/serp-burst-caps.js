/**
 * Pure cap-decision logic for the opening-night SERP "burst" (West End, and since
 * BRO-4272 Broadway on an hourly spacing).
 *
 * BROADWAY (BRO-4272, School Girls 2026-09-28): the same deferral starvation hit a
 * Broadway opening. Every poller run that night carried --skip-serp, so the curated
 * Broadway T3 SERP list (which already names stageandcinema) never ran and Stage and
 * Cinema's review was found only by a manual web search. DEFAULT_BW_SERP_BURST_CONFIG
 * lets a Broadway show override --skip-serp at most once an hour, only
 * after its first reviews landed, with its own caps and kill switch
 * (DISABLE_BW_SERP_BURST) so it can't starve West End bursts.
 *
 * WHY THIS EXISTS (corrected diagnosis 2026-06-04, data/audit/we-serp-diagnosis-corrected.md):
 * SERP is skipped during WE opening windows NOT because ScrapingBee credits run low
 * (they never drop below ~34%; the orchestrator's skip floor is 1%), but because
 * opening-night-orchestrator.yml defers SERP to iterations 9-10 (SERP_DEFER_ITERATIONS=8)
 * and those orchestrator runs are routinely cancelled before reaching them. So an
 * actively-opening WE show — where the poller's OWN cadence (shouldRunSerpForMode) would
 * correctly run SERP every cycle — gets `--skip-serp` forced on it and never runs SERP.
 *
 * This helper lets the poller override an incoming `--skip-serp` for aggressive-window WE
 * shows, behind the ENABLE_WE_SERP_BURST flag (default OFF), but ONLY under hard ceilings
 * so it can never run unbounded (this repo has hit 1000+ runs/day cascades — see
 * memory/feedback_workflow_cascade_prevention.md).
 *
 * The decision is a PURE function of its inputs (mirrors scripts/lib/browserbase-caps.js):
 * the caller owns the ledger I/O and passes current counts in, so the cap logic is
 * unit-testable with concrete inputs. Production code requires this module — change the
 * function, the test fails.
 *
 * A "burst" = ONE poller cycle that ran SERP despite an incoming `--skip-serp`. The
 * per-cycle SERP fan-out is separately bounded by SERP_BUDGET (12 outlet calls/cycle) in
 * the poller. So total daily SERP calls <= dailyGlobalCap * SERP_BUDGET (worst case, before
 * the natural getFoundOutletIds decay that makes real usage far lower).
 */

const DEFAULT_SERP_BURST_CONFIG = {
  // Markets eligible for the WE burst. Broadway has its own config below
  // (DEFAULT_BW_SERP_BURST_CONFIG) with hourly spacing and separate caps.
  markets: ['west-end', 'off-west-end'],
  // Keep the existing 3h-post-opening gate: SERP indexes major outlets ~3h after publication.
  minHoursAfterOpening: 3,
  // Per-show ceiling: at most this many SERP-running cycles per show per UTC day.
  perShowCap: 12,
  // Global ceiling across ALL shows per UTC day (covers ~2-3 concurrent WE openings).
  dailyGlobalCap: 30,
  // Emit a cascade ::warning:: once daily bursts reach this many (early signal, < cap).
  cascadeTripwire: 24,
};

const DEFAULT_BW_SERP_BURST_CONFIG = {
  // Broadway only: pollMode (opening-night-poller.js) gives off-Broadway no aggressive
  // window, so an OB entry here could never fire. OB reviews trickle in over weeks and
  // its normal daily SERP cadence covers them.
  markets: ['broadway'],
  minHoursAfterOpening: 3,
  // One sweep an hour. Broadway's aggressive window is ~14h (pollMode: 22:00 UTC on
  // opening day to 12:00 UTC next day), so this alone bounds a show to ~14 bursts.
  minMinutesBetweenBursts: 60,
  // Don't sweep before any review has landed: SERP returns nothing useful yet.
  requireFirstReviews: true,
  // Daily caps count in the ledger's own Broadway bucket, apart from the WE one.
  // The per-show cap resets at 00:00 UTC, mid-window; the hourly spacing is the
  // bound that holds across the reset (lastBurstAt survives it).
  perShowCap: 14,
  dailyGlobalCap: 30,
  cascadeTripwire: 24,
};

/**
 * Decide whether a SERP burst is allowed for this poller cycle.
 *
 * @param {object} params
 * @param {boolean} params.flagEnabled        - ENABLE_WE_SERP_BURST resolved to a boolean
 * @param {object}  params.show               - show object ({ category|market, openingDate })
 * @param {string}  params.mode               - pollMode(show) result ('aggressive'|'daily'|...)
 * @param {number|null} params.hoursSinceOpening - hours since openingDate, or null if unknown
 * @param {number}  params.burstsToday         - global bursts already used today
 * @param {number}  params.burstsForShowToday  - bursts already used today for THIS show
 * @param {number|null} [params.minutesSinceLastBurstForShow] - null/undefined = never burst
 * @param {boolean} [params.firstReviewsLanded] - at least one review already stored for the show
 * @param {object}  [params.config]            - cap config (defaults to DEFAULT_SERP_BURST_CONFIG)
 * @returns {{allowed: boolean, reason: string, limit?: number, used?: number}}
 */
function checkSerpBurstAllowed({
  flagEnabled,
  show,
  mode,
  hoursSinceOpening,
  burstsToday,
  burstsForShowToday,
  minutesSinceLastBurstForShow = null,
  firstReviewsLanded = false,
  config = DEFAULT_SERP_BURST_CONFIG,
}) {
  if (!flagEnabled) return { allowed: false, reason: 'flag-off' };

  const cat = (show && (show.category || show.market)) || '';
  if (!config.markets.includes(cat)) return { allowed: false, reason: 'market' };

  if (mode !== 'aggressive') return { allowed: false, reason: 'not-aggressive-window' };

  // Defense-in-depth: a burst REQUIRES a known opening time. Without one we cannot enforce
  // the 3h-post-opening gate, so refuse rather than rely on pollMode's null-date default
  // (which today returns a non-aggressive mode, but that coupling must not be load-bearing).
  if (hoursSinceOpening == null) return { allowed: false, reason: 'no-opening-time' };

  if (hoursSinceOpening < config.minHoursAfterOpening) {
    return { allowed: false, reason: '3h-gate' };
  }

  if (config.requireFirstReviews && !firstReviewsLanded) {
    return { allowed: false, reason: 'no-reviews-yet' };
  }

  if (config.minMinutesBetweenBursts && minutesSinceLastBurstForShow != null
      && minutesSinceLastBurstForShow < config.minMinutesBetweenBursts) {
    return {
      allowed: false,
      reason: 'hourly-spacing',
      limit: config.minMinutesBetweenBursts,
      used: Math.floor(minutesSinceLastBurstForShow),
    };
  }

  if (burstsToday >= config.dailyGlobalCap) {
    return { allowed: false, reason: 'daily-global-cap', limit: config.dailyGlobalCap, used: burstsToday };
  }

  if (burstsForShowToday >= config.perShowCap) {
    return { allowed: false, reason: 'per-show-cap', limit: config.perShowCap, used: burstsForShowToday };
  }

  return { allowed: true, reason: 'ok' };
}

/**
 * Cascade tripwire: true once the day's burst count has reached the early-warning
 * threshold (below the hard cap). Caller emits a ::warning:: so a runaway is visible
 * before it hits the ceiling.
 */
function isCascadeTripwireExceeded(burstsToday, config = DEFAULT_SERP_BURST_CONFIG) {
  return burstsToday >= config.cascadeTripwire;
}

/**
 * Cron-math projection used for the pre-enable dry-run (records the worst-case daily
 * SERP fan-out so we can confirm it stays under the BD/SB caps before flipping the flag).
 *
 * @param {object} p
 * @param {number} p.concurrentWeOpenings - WE shows simultaneously in the aggressive window
 * @param {number} p.serpBudgetPerCycle   - per-cycle outlet-call budget (SERP_BUDGET, 12)
 * @param {object} [p.config]
 * @returns {{maxBurstsPerDay:number, maxSerpCallsPerDay:number, perShowCap:number,
 *            dailyGlobalCap:number, boundedBy:string}}
 */
function projectDailySerpBurstCeiling({ concurrentWeOpenings, serpBudgetPerCycle, config = DEFAULT_SERP_BURST_CONFIG }) {
  // Bursts are bounded by BOTH the per-show cap (× concurrent shows) AND the global cap,
  // whichever is smaller — that's the real ceiling.
  const byPerShow = config.perShowCap * Math.max(0, concurrentWeOpenings);
  const maxBurstsPerDay = Math.min(byPerShow, config.dailyGlobalCap);
  return {
    maxBurstsPerDay,
    maxSerpCallsPerDay: maxBurstsPerDay * serpBudgetPerCycle,
    perShowCap: config.perShowCap,
    dailyGlobalCap: config.dailyGlobalCap,
    boundedBy: byPerShow <= config.dailyGlobalCap ? 'per-show' : 'daily-global',
  };
}

/**
 * Order the missing outlets for one SERP pass so repeated passes cover the whole list.
 *
 * On a Broadway opening night ~70 T1/T2 outlets read as "missing" (most never review a
 * given show) against a 12-call budget, and the T3 outlets are queued after all of them,
 * so a plain tier sort re-searches the same first 12 every pass and never reaches a T3
 * like stageandcinema (BRO-4272). Order per pass:
 *   1. T1 outlets, always first (rotated among themselves only when they overflow);
 *   2. T2 outlets, rotated by `rotation` (passes already run) through the remaining slots;
 *   3. `lowTierReserve` slots for tier-3+ outlets, rotated the same way.
 * Unused reserve falls back to T1/T2.
 *
 * @param {object[]} outlets - missing outlets ({id, tier}), any order
 * @param {object} opts
 * @param {number} opts.budget         - calls this pass (SERP_BUDGET)
 * @param {number} [opts.lowTierReserve=3]
 * @param {number} [opts.rotation=0]
 * @returns {object[]} at most `budget` outlets, T1 first
 */
function planSerpOutlets(outlets, { budget, lowTierReserve = 3, rotation = 0 }) {
  const list = outlets || [];
  const t1 = list.filter((o) => (o.tier || 3) <= 1);
  const t2 = list.filter((o) => (o.tier || 3) === 2);
  const low = list.filter((o) => (o.tier || 3) > 2);
  const rotate = (arr, n) => {
    if (!arr.length) return arr;
    const k = ((n % arr.length) + arr.length) % arr.length;
    return [...arr.slice(k), ...arr.slice(0, k)];
  };
  const lowSlots = Math.min(lowTierReserve, low.length, budget);
  const highSlots = budget - lowSlots;
  // T1 gets up to two thirds of the high slots while T2 is waiting (all of them when
  // not); on School Girls 9 T1s were missing against 9 slots, which would starve T2.
  const t1Cap = t2.length ? Math.ceil((highSlots * 2) / 3) : highSlots;
  const t1Take = rotate(t1, rotation * t1Cap).slice(0, t1Cap);
  const t2Slots = highSlots - t1Take.length;
  const t2Take = rotate(t2, rotation * t2Slots).slice(0, t2Slots);
  // Slots T2 couldn't use go back to the T1 outlets left out above.
  const t1Rest = rotate(t1, rotation * t1Cap).slice(t1Cap, t1Cap + (t2Slots - t2Take.length));
  t1Take.push(...t1Rest);
  const used = t1Take.length + t2Take.length;
  const lowTake = rotate(low, rotation * lowSlots).slice(0, budget - used);
  return [...t1Take, ...t2Take, ...lowTake];
}

module.exports = {
  DEFAULT_SERP_BURST_CONFIG,
  DEFAULT_BW_SERP_BURST_CONFIG,
  planSerpOutlets,
  checkSerpBurstAllowed,
  isCascadeTripwireExceeded,
  projectDailySerpBurstCeiling,
};
