/**
 * Permanent-failure policy for data/review-texts/failed-fetches.json.
 *
 * Extracted (Scraping cost v3 S2-T5/T6) because collect-review-texts.js
 * implements this decision TWICE — once when recording a failure (~line 6050)
 * and once when loading the ledger to build the permanentlyFailed set (~line
 * 5510) — with a comment asserting the two must agree. A comment is not a
 * mechanism; both call sites now resolve the same function, so they cannot
 * drift (CLAUDE.md rule 15, same reasoning as browserbase-caps.js's single
 * ceiling constant).
 *
 * THE reason this became urgent: the Bright Data circuit breaker (S2-T3) makes
 * a fetch fail for a reason that says nothing about the URL. Without the
 * budget_capped carve-out below, four capped attempts plus one genuine
 * transient failure would permanently retire a perfectly good review URL —
 * the breaker would quietly delete coverage instead of deferring spend. The
 * plan review was explicit that the exclusion must live at the COUNTER (write
 * time), not only at the read threshold: a write-time increment is permanent
 * damage that a read-time filter cannot undo once other reasons accumulate.
 */
'use strict';

/**
 * Failure reasons that reflect OUR spend decisions, not the URL's health.
 * These never increment failureCount and never contribute to retirement.
 */
const NON_EVIDENCE_REASONS = Object.freeze(['budget_capped']);

/** @param {string} reason */
function isNonEvidenceFailure(reason) {
  return NON_EVIDENCE_REASONS.includes(reason);
}

/**
 * Should this failure increment the review's failureCount?
 * @param {string} reason
 */
function shouldCountFailure(reason) {
  return !isNonEvidenceFailure(reason);
}

/**
 * Is this failure reason strong evidence the URL itself is bad (as opposed to
 * a transient scraper/network issue)? Single source of truth for the
 * dead/garbage vs everything-else split — consumed by both isPermanentlyFailed
 * (flat threshold) and review-guards.js's shouldRetryFetch (lifecycle-tiered
 * threshold), so the two can never classify the same reason differently
 * (BRO-787 — the lifecycle guard was built by re-deriving this split inline
 * before ship-check caught the drift risk).
 *
 * url_dead_404 / url_dead_410 — the server confirmed the page is gone.
 * garbage_content             — site serves content, but never the review.
 *
 * @param {string} reason
 */
function isStrictFailureReason(reason) {
  return reason === 'garbage_content' || reason === 'url_dead_404' || reason === 'url_dead_410';
}

/**
 * Is this failed-fetches entry retired from future runs?
 *
 * Thresholds (unchanged from the inline logic this replaces):
 *   strict (dead/garbage) → 3 failures
 *   everything else       → 5 failures
 *   budget_capped         → never (not evidence about the URL)
 *
 * @param {{failureReason?: string, failureCount?: number}} entry
 */
function isPermanentlyFailed(entry) {
  const reason = (entry && entry.failureReason) || '';
  const count = (entry && entry.failureCount) || 0;
  if (isNonEvidenceFailure(reason)) return false;
  return count >= (isStrictFailureReason(reason) ? 3 : 5);
}

module.exports = {
  NON_EVIDENCE_REASONS,
  isNonEvidenceFailure,
  shouldCountFailure,
  isStrictFailureReason,
  isPermanentlyFailed,
};
