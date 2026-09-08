'use strict';

/**
 * Pure verdict for the ScrapingBee credit line in the opening-night readiness
 * checklist (CLAUDE.md rule 14, check 10).
 *
 * Extracted from scripts/check-opening-night-readiness.js the same way
 * lib/show-image-presence.js was extracted from that same file: the decision
 * has to be require()-able so a test can pin it (CLAUDE.md rule 15), and
 * because check-opening-night-readiness.js is NOT in test.yml's push-path
 * allow-list, logic left inline there gets ZERO CI on a solo push
 * (memory/feedback_test_yml_push_path_allowlist.md). scripts/lib/** is
 * globbed, so living here is what puts it under CI at all.
 *
 * This exists because the inline version read `usage.used`, a field the
 * ScrapingBee /usage endpoint has never returned, so it scored 0% and
 * reported PASS at every real usage level (BRO-3032).
 */

/** Attention line. House standard: credit-preflight.js minPct=25 remaining,
 *  opening-night-readiness.js:81. */
const DEFAULT_WARN_PCT_USED = 50;
const DEFAULT_ATTENTION_PCT_USED = 75;

/**
 * Fail the gate only at genuine exhaustion, not at the attention line.
 *
 * The attention line (75% used / 25% remaining) is the house number and stays
 * a WARN here on purpose. ScrapingBee is a FALLBACK link in the page chain,
 * and the owner's standing decision on a burnt SB cycle is to ride it out
 * rather than act (memory/feedback_sb_quota_ride_out.md). Last cycle reached
 * 922K of 1M, so a gate that exits non-zero above 75% would have reported
 * "NOT READY" for a large part of a normal month, drowning the other twenty
 * checks in the same summary and reddening every auto-triggered run — a check
 * that cries wolf for weeks is the same dead alarm as one that never fires,
 * which is the bug this module was written to fix.
 */
const DEFAULT_FAIL_PCT_USED = 100;

/**
 * @param {Object} status - the object returned by lib/check-sb-credits.js
 *   fetchSBCreditStatus(): either {ok:true, maxCredits, usedCredits, remaining,
 *   pctUsed, pctRemaining} or {ok:false, reason, message}.
 * @param {Object} [thresholds]
 * @returns {{level: 'pass'|'warn'|'fail'|'skip', detail: string}}
 */
function sbCreditVerdict(status, thresholds = {}) {
  const warnAt = thresholds.warnPctUsed ?? DEFAULT_WARN_PCT_USED;
  const attentionAt = thresholds.attentionPctUsed ?? DEFAULT_ATTENTION_PCT_USED;
  const failAt = thresholds.failPctUsed ?? DEFAULT_FAIL_PCT_USED;

  if (!status || typeof status !== 'object') {
    return { level: 'warn', detail: 'No usage status returned' };
  }

  if (!status.ok) {
    // Unknown is not exhausted. A transient 500, a missing key, or a payload
    // whose shape we cannot read must not fail an opening-night gate — but it
    // must not silently pass either, which is exactly what the old code did.
    // fetchSBCreditStatus already classifies max_api_credit <= 0 as 'no-max',
    // so a zero cap lands here rather than being turned into a 100% ratio.
    if (status.reason === 'no-key') {
      return { level: 'skip', detail: 'SCRAPINGBEE_API_KEY not set — check in CI' };
    }
    return {
      level: 'warn',
      detail: `Could not read ScrapingBee credits (${status.reason || 'unknown'}): ${status.message || 'no detail'}`,
    };
  }

  const { pctUsed, usedCredits, maxCredits, remaining } = status;
  if (!Number.isFinite(pctUsed)) {
    return { level: 'warn', detail: 'Usage response parsed but percentage is not a finite number' };
  }

  const where = `${pctUsed}% used (${usedCredits}/${maxCredits}, ${remaining} left)`;
  if (pctUsed >= failAt) {
    return { level: 'fail', detail: `${where}. Cycle exhausted — ScrapingBee fallbacks will not serve.` };
  }
  if (pctUsed > attentionAt) {
    return { level: 'warn', detail: `${where}. Past the ${attentionAt}% attention line — riding it out per policy, but SB fallbacks are thin.` };
  }
  if (pctUsed > warnAt) {
    return { level: 'warn', detail: `${where}. Monitor.` };
  }
  return { level: 'pass', detail: where };
}

module.exports = {
  sbCreditVerdict,
  DEFAULT_WARN_PCT_USED,
  DEFAULT_ATTENTION_PCT_USED,
  DEFAULT_FAIL_PCT_USED,
};
