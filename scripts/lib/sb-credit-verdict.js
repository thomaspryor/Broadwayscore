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
 * The strongest reason is not policy, it is that the hard gate already exists
 * somewhere better: check 11b of the same readiness script runs a DEMAND-aware
 * budget check (lib/opening-night-budget.js checkBudget, ~50,000 SB credits
 * estimated per show) and blocks when projected demand exceeds what is
 * actually left. That is the check that should stop an opening night, because
 * it knows how many shows are opening; a flat percentage does not. Duplicating
 * a hard stop here would only add a second, dumber gate that fires first.
 *
 * The attention line (75% used / 25% remaining) is the house number
 * (credit-preflight.js minPct=25, opening-night-readiness.js:81) and stays a
 * WARN. ScrapingBee is a FALLBACK link in the page chain and the owner's
 * standing decision on a burnt cycle is to ride it out
 * (memory/feedback_sb_quota_ride_out.md). Last cycle reached 922K of 1M, so a
 * gate that exited non-zero above 75% would have reported "NOT READY" for a
 * large part of a normal month, drowning the other twenty checks — a check
 * that cries wolf for weeks is the same dead alarm as one that never fires,
 * which is the bug this module was written to fix.
 *
 * Overridable without a deploy via SB_READINESS_FAIL_PCT_USED (and the two
 * siblings below), so restoring a 75% hard failure at 2am is an env change,
 * not an edit-and-redeploy.
 */
const DEFAULT_FAIL_PCT_USED = 100;

function envPct(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {Object} status - the object returned by lib/check-sb-credits.js
 *   fetchSBCreditStatus(): either {ok:true, maxCredits, usedCredits, remaining,
 *   pctUsed, pctRemaining} or {ok:false, reason, message}.
 * @param {Object} [thresholds]
 * @returns {{level: 'pass'|'warn'|'fail'|'skip', detail: string}}
 */
function sbCreditVerdict(status, thresholds = {}) {
  const warnAt = thresholds.warnPctUsed ?? envPct('SB_READINESS_WARN_PCT_USED', DEFAULT_WARN_PCT_USED);
  const attentionAt = thresholds.attentionPctUsed ?? envPct('SB_READINESS_ATTENTION_PCT_USED', DEFAULT_ATTENTION_PCT_USED);
  const failAt = thresholds.failPctUsed ?? envPct('SB_READINESS_FAIL_PCT_USED', DEFAULT_FAIL_PCT_USED);

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

  // Exhaustion is decided on RAW credits remaining, never on the rounded
  // percentage. fetchSBCreditStatus rounds pctUsed, so 995,000 of 1,000,000
  // presents as "100%" with 5,000 credits still spendable; a percentage-based
  // exhaustion test would report "Cycle exhausted" and fail an opening-night
  // gate with a working account (BRO-3032 review). Only when the caller has
  // deliberately lowered failAt below 100 does the percentage govern — that is
  // an operator asking for a headroom gate, not an exhaustion test.
  const exhausted = Number.isFinite(remaining)
    ? remaining <= 0
    : pctUsed >= 100;
  if (exhausted) {
    return { level: 'fail', detail: `${where}. Cycle exhausted — ScrapingBee fallbacks will not serve.` };
  }
  if (failAt < 100 && pctUsed >= failAt) {
    return { level: 'fail', detail: `${where}. Past the ${failAt}% hard line configured for this run.` };
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
