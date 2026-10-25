/**
 * Pure decision functions for scripts/audit-tier-skip-drift.js (Scraping cost
 * v3, card 3b1637c5, S1-T3).
 *
 * domain-tier-skip.json entries go stale in both directions and nothing
 * catches it: a skip:false host can quietly degrade (S1-T1 found DTLI's
 * 07-31 skip:false conclusion held on a clean retest, but the card's whole
 * premise was that a *different* host's stale conclusion had gone unnoticed
 * for weeks) and a skip:true host can quietly recover (the provider fixes
 * whatever broke, but nobody re-tries it). Two independent checks:
 *   - degrade: skip:false but the live 7-day ledger shows the tier failing
 *     hard on a domain with real call volume — should flip to skip:true.
 *   - recovery: skip:true — a small monthly live probe checks whether the
 *     tier works again — should flip to skip:false.
 * Mirrors scripts/lib/browserbase-caps.js's shape: pure fn + params object,
 * config resolved via a small resolver so env overrides don't fork the logic.
 */

const DEFAULT_DEGRADE_MIN_CALLS = 100;
const DEFAULT_DEGRADE_THRESHOLD = 0.30;
const DEFAULT_RECOVERY_PROBE_SIZE = 5;
const DEFAULT_RECOVERY_THRESHOLD = 0.60; // matches the plan's ">=80% keep, <30% skip, else ambiguous" bar's upper anchor loosely — recovery uses a lower bar (3/5) since a probe sample is much smaller than the 30-URL parity test

/**
 * Degrade direction: is a currently-unskipped (skip:false) domain+tier
 * failing hard enough on live traffic to warrant flipping to skip:true?
 *
 * @param {object} params
 * @param {boolean} params.currentSkip - current skip:true/false for this domain+tier
 * @param {number} params.successes - successful calls in the observation window
 * @param {number} params.failures - failed calls in the observation window
 * @param {number} [params.minCalls] - minimum sample size before alerting (avoids noise on low-volume domains)
 * @param {number} [params.threshold] - success rate below this trips the alert
 * @returns {{alert: boolean, reason: string, successRate: number|null, totalCalls: number}}
 */
function evaluateDegradeDrift({ currentSkip, successes, failures, minCalls = DEFAULT_DEGRADE_MIN_CALLS, threshold = DEFAULT_DEGRADE_THRESHOLD }) {
  const totalCalls = (successes || 0) + (failures || 0);
  if (currentSkip) {
    return { alert: false, reason: 'already skip:true — degrade direction does not apply', successRate: null, totalCalls };
  }
  if (totalCalls < minCalls) {
    return { alert: false, reason: `insufficient sample (${totalCalls} < ${minCalls} calls)`, successRate: null, totalCalls };
  }
  const successRate = successes / totalCalls;
  if (successRate < threshold) {
    return {
      alert: true,
      reason: `skip:false but ${(successRate * 100).toFixed(0)}% success over ${totalCalls} calls (< ${(threshold * 100).toFixed(0)}% threshold) — consider flipping to skip:true`,
      successRate,
      totalCalls,
    };
  }
  return { alert: false, reason: `${(successRate * 100).toFixed(0)}% success over ${totalCalls} calls — healthy`, successRate, totalCalls };
}

/**
 * Recovery direction: does a currently-skipped (skip:true) domain+tier
 * deserve a re-test based on a small live probe's results?
 *
 * @param {object} params
 * @param {boolean} params.currentSkip
 * @param {number} params.probeSuccesses - successes out of the probe sample
 * @param {number} params.probeTotal - probe sample size actually attempted (may be < configured size if URLs were unavailable)
 * @param {number} [params.minProbeSize] - minimum attempts before trusting the probe
 * @param {number} [params.threshold] - success rate at/above which recovery is flagged
 * @returns {{alert: boolean, reason: string, successRate: number|null}}
 */
function evaluateRecoveryProbe({ currentSkip, probeSuccesses, probeTotal, minProbeSize = DEFAULT_RECOVERY_PROBE_SIZE, threshold = DEFAULT_RECOVERY_THRESHOLD }) {
  if (!currentSkip) {
    return { alert: false, reason: 'skip:false — recovery direction does not apply', successRate: null };
  }
  if (probeTotal < minProbeSize) {
    return { alert: false, reason: `insufficient probe sample (${probeTotal} < ${minProbeSize} URLs)`, successRate: null };
  }
  const successRate = probeSuccesses / probeTotal;
  if (successRate >= threshold) {
    return {
      alert: true,
      reason: `skip:true but recovery probe succeeded ${probeSuccesses}/${probeTotal} (${(successRate * 100).toFixed(0)}%) — consider flipping to skip:false`,
      successRate,
    };
  }
  return { alert: false, reason: `probe ${probeSuccesses}/${probeTotal} (${(successRate * 100).toFixed(0)}%) — still failing, no change`, successRate };
}

function resolveDegradeConfig(env = process.env) {
  const minCalls = parseInt(env.TIER_SKIP_DRIFT_MIN_CALLS, 10);
  const thresholdPct = parseInt(env.TIER_SKIP_DRIFT_THRESHOLD_PCT, 10);
  return {
    minCalls: Number.isFinite(minCalls) && minCalls > 0 ? minCalls : DEFAULT_DEGRADE_MIN_CALLS,
    threshold: Number.isFinite(thresholdPct) && thresholdPct > 0 && thresholdPct < 100 ? thresholdPct / 100 : DEFAULT_DEGRADE_THRESHOLD,
  };
}

module.exports = {
  evaluateDegradeDrift,
  evaluateRecoveryProbe,
  resolveDegradeConfig,
  DEFAULT_DEGRADE_MIN_CALLS,
  DEFAULT_DEGRADE_THRESHOLD,
  DEFAULT_RECOVERY_PROBE_SIZE,
  DEFAULT_RECOVERY_THRESHOLD,
};
