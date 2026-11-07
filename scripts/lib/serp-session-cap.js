/**
 * Pure cap-decision logic for the opening-night poller's SERP layer (Layer 4).
 *
 * WHY THIS EXISTS (SERP-cadence redesign 2026-06-05, sprint-plan-serp-cadence.md,
 * Notion 376637c5-416f-817c-a42d-e2e92c0cc115):
 * Three overlapping SERP throttles currently govern opening-night SERP — the poller's
 * own cadence gate (shouldRunSerpForMode), the orchestrator's SERP_DEFER_ITERATIONS
 * deferral, and the WE SERP burst override. Sprint 2 removes the orchestrator deferral
 * so the poller becomes the single owner of "when to run SERP". Before that cost control
 * is removed, this module installs an EXPLICIT per-show + daily-global ceiling on
 * SERP-running poller cycles, bounding the now-poller-owned SERP (this repo has hit
 * 1000+ runs/day cascades — memory/feedback_workflow_cascade_prevention.md). The ceiling
 * is ADVISORY across concurrent CI runs (the caller's ledger is read-modify-write, like
 * serp-burst-caps.js), so the true HARD per-cycle bound remains SERP_BUDGET (12 outlet
 * calls); this cap bounds the NUMBER of SERP-running cycles per UTC day, fail-closed.
 *
 * SPRINT 1 INVARIANT — this cap is a STRICT NO-OP at today's volume. Ground truth
 * (data/audit/we-serp-diagnosis-corrected.md, S1-T1): ~0-2 SERP-running cycles per
 * opening per UTC day today; even a busy post-deferral-removal opening is ~10-20 cycles.
 * The defaults below (perShowCap 30, dailyGlobalCap 60) sit 15-30× above that, so the
 * cap NEVER binds in normal operation — it only stops a genuine runaway.
 *
 * The decision is a PURE function of its inputs (mirrors scripts/lib/serp-burst-caps.js
 * and scripts/lib/browserbase-caps.js): the CALLER owns the ledger I/O and passes the
 * current counts in, so the cap logic is unit-testable with concrete inputs. Production
 * code requires this module — change the function, the test fails.
 *
 * MARKET-AGNOSTIC by design: unlike the WE-only burst, this cap bounds SERP for EVERY
 * opening-night market (Broadway, West End, off-Broadway, off-West-End), because after
 * Sprint 2 the poller owns SERP for all of them. There is no market gate here.
 *
 * A "session" = ONE poller cycle that ran SERP (one runSERPBackup invocation). The
 * per-cycle SERP fan-out is separately bounded by SERP_BUDGET (12 outlet calls/cycle)
 * in the poller. So total daily SERP outlet calls <= dailyGlobalCap * SERP_BUDGET
 * (worst case, before the natural getFoundOutletIds decay that makes real usage lower).
 */

const DEFAULT_SERP_SESSION_CONFIG = {
  // Per-show ceiling: at most this many SERP-running poller cycles per show per UTC day.
  // Sized from S1-T1: today ~2 cycles/opening → ~15× headroom; binds only on a loop.
  perShowCap: 30,
  // Global ceiling across ALL shows/markets per UTC day. Covers ~2-3 concurrent openings
  // at up to perShowCap each (clipped here). Worst-case SERP outlet calls/day =
  // dailyGlobalCap * SERP_BUDGET(12) = 720, same order as the proven-safe WE burst (360).
  dailyGlobalCap: 60,
};

/**
 * Decide whether a SERP-running poller cycle is allowed under the daily session cap.
 *
 * This does NOT decide whether SERP *should* run for cadence reasons — the poller's
 * existing gate (shouldRunSerp / shouldRunSerpForMode / the 3h-since-opening gate) owns
 * that and runs FIRST. This is purely the cost ceiling consulted just before runSERPBackup.
 *
 * @param {object} params
 * @param {number} params.perShowToday  - SERP-running cycles already used today for THIS show
 * @param {number} params.globalToday   - SERP-running cycles already used today across ALL shows
 * @param {object} [params.config]      - cap config (defaults to DEFAULT_SERP_SESSION_CONFIG)
 * @returns {{allowed: boolean, reason: string, limit?: number, used?: number}}
 */
function checkSerpSessionAllowed({ perShowToday, globalToday, config = DEFAULT_SERP_SESSION_CONFIG }) {
  // Global cap is checked BEFORE per-show so a single show can't be told "you're fine"
  // when the account-wide ceiling is already hit (mirrors serp-burst-caps ordering).
  if (globalToday >= config.dailyGlobalCap) {
    return { allowed: false, reason: 'daily-global-cap', limit: config.dailyGlobalCap, used: globalToday };
  }
  if (perShowToday >= config.perShowCap) {
    return { allowed: false, reason: 'per-show-cap', limit: config.perShowCap, used: perShowToday };
  }
  return { allowed: true, reason: 'ok' };
}

/**
 * Cron-math projection: worst-case daily SERP fan-out under the cap, for the pre-removal
 * dry-run (S2-T5 records this to confirm it stays under the BD/SB caps before the
 * orchestrator deferral is removed).
 *
 * @param {object} p
 * @param {number} p.concurrentOpenings - shows simultaneously running SERP in their windows
 * @param {number} p.serpBudgetPerCycle - per-cycle outlet-call budget (SERP_BUDGET, 12)
 * @param {object} [p.config]
 * @returns {{maxSessionsPerDay:number, maxSerpCallsPerDay:number, perShowCap:number,
 *            dailyGlobalCap:number, boundedBy:string}}
 */
function projectDailySerpCeiling({ concurrentOpenings, serpBudgetPerCycle, config = DEFAULT_SERP_SESSION_CONFIG }) {
  // Sessions are bounded by BOTH the per-show cap (× concurrent shows) AND the global cap,
  // whichever is smaller — that's the real ceiling.
  const byPerShow = config.perShowCap * Math.max(0, concurrentOpenings);
  const maxSessionsPerDay = Math.min(byPerShow, config.dailyGlobalCap);
  return {
    maxSessionsPerDay,
    maxSerpCallsPerDay: maxSessionsPerDay * serpBudgetPerCycle,
    perShowCap: config.perShowCap,
    dailyGlobalCap: config.dailyGlobalCap,
    boundedBy: byPerShow <= config.dailyGlobalCap ? 'per-show' : 'daily-global',
  };
}

module.exports = {
  DEFAULT_SERP_SESSION_CONFIG,
  checkSerpSessionAllowed,
  projectDailySerpCeiling,
};
