/**
 * Pure cap-decision logic for the West End opening-night SERP "burst".
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
  // Markets eligible for the burst. WE reviews drop in a tight next-morning window where
  // early SERP matters; Broadway is handled by its own aggressive-window timing and is not
  // affected by the same deferral starvation pattern, so it is intentionally excluded here.
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

module.exports = {
  DEFAULT_SERP_BURST_CONFIG,
  checkSerpBurstAllowed,
  isCascadeTripwireExceeded,
  projectDailySerpBurstCeiling,
};
