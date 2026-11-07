/**
 * Auto-clear SHADOW MODE (Sprint 3 S3-T4, sprint-plan-t1-retrieval.md).
 *
 * Auto-clearing a stale exclusion flag MOVES LIVE SCORES (the #1 risk of this
 * sprint). Before any auto-clear is enabled (S3-T5), we observe what an
 * auto-clearer WOULD do for a real 48h window and prove it agrees with human
 * triage. This module is that shadow: a pure "would-auto-clear" decision + the
 * evidence-sufficiency gate the S3-T5 enable path consults.
 *
 * wouldAutoClear() is STRICTER than the escalate-only detectFlagContradiction:
 * escalation is cheap (an email a human vets), auto-clear is not, so auto-clear
 * additionally refuses to act on a LOW-confidence contentVerification verdict
 * (a low-confidence "right production" call is not strong enough to silently
 * un-suppress a review). Everything the escalate detector refuses, this refuses
 * too (human-decided, older CV, no flag timestamp, CV agrees with the flag).
 *
 * assessShadowEvidence() encodes the S3-T4 VERIFY bar: the evidence is only
 * "clean" with ≥ minCandidates LIVE observed would-clear candidates over ≥
 * minWindowHours of observation AND zero human disagreements. Fewer candidates
 * or a shorter window ⇒ "insufficient-evidence" ⇒ auto-clear STAYS OFF (the
 * plan's explicitly-allowed conclusion). A zero-candidate report is vacuous by
 * construction and can never read as clean.
 *
 * Pure — no I/O. The hourly sweep (audit-t1-silent-gaps.js) appends live
 * observations to the shadow log; the report CLI (shadow-autoclear-report.js)
 * and the unit test consume these functions.
 */

'use strict';

const { detectFlagContradiction } = require('./flag-contradiction');

// The 48h / ≥3-candidate bar from the plan (S3-T4 VERIFY).
const SHADOW_MIN_WINDOW_HOURS = 48;
const SHADOW_MIN_CANDIDATES = 3;

/**
 * Would an auto-clearer clear this file's stale flag? Returns a decision with a
 * reason for both outcomes (so the shadow log records WHY, not just yes/no).
 *
 * @param {object} file - parsed review-text JSON
 * @returns {{clear: boolean, flag: string|null, reason: string,
 *            flaggedAt?: string|null, verifiedAt?: string}}
 */
function wouldAutoClear(file) {
  const contra = detectFlagContradiction(file);
  if (!contra) return { clear: false, flag: null, reason: 'no-contradiction' };
  // Stricter-than-escalate gate: never auto-act on a low-confidence CV verdict.
  const conf = file.contentVerification && file.contentVerification.confidence;
  if (conf === 'low') {
    return { clear: false, flag: contra.flag, reason: 'cv-confidence-low', verifiedAt: contra.verifiedAt };
  }
  return {
    clear: true,
    flag: contra.flag,
    reason: 'stale-flag-newer-cv',
    flaggedAt: contra.flaggedAt,
    verifiedAt: contra.verifiedAt,
  };
}

/**
 * Build a shadow-log observation for a live would-clear candidate. `observedAt`
 * is injected (the caller stamps it) so the module stays pure/test-friendly.
 */
function shadowObservation({ showId, file, outletId, tier, decision, observedAt }) {
  return {
    observedAt,
    showId,
    file,
    outletId: outletId || null,
    tier: tier == null ? null : tier,
    flag: decision.flag,
    reason: decision.reason,
    flaggedAt: decision.flaggedAt || null,
    verifiedAt: decision.verifiedAt || null,
    // humanVerdict starts null; a human annotates 'agree'/'disagree' during the
    // 48h review. A null humanVerdict is NOT a disagreement, but it also does
    // not count toward "clean" — the window needs affirmatively-reviewed cases.
    humanVerdict: null,
  };
}

/**
 * Assess whether the shadow evidence is clean enough to enable auto-clear.
 *
 * @param {object} p
 * @param {Array} p.observations   - shadow-log entries (live would-clear candidates)
 * @param {number} p.windowHours   - hours spanned by the observations
 * @param {number} [p.minCandidates]
 * @param {number} [p.minWindowHours]
 * @returns {{verdict: 'clean'|'insufficient-evidence', candidates: number,
 *            reviewed: number, agreed: number, disagreed: number,
 *            windowHours: number, reasons: string[]}}
 */
function assessShadowEvidence({
  observations = [],
  windowHours = 0,
  minCandidates = SHADOW_MIN_CANDIDATES,
  minWindowHours = SHADOW_MIN_WINDOW_HOURS,
} = {}) {
  const candidates = observations.length;
  const reviewed = observations.filter((o) => o.humanVerdict === 'agree' || o.humanVerdict === 'disagree');
  const disagreed = reviewed.filter((o) => o.humanVerdict === 'disagree').length;
  const agreed = reviewed.length - disagreed;
  const reasons = [];

  if (candidates < minCandidates) {
    reasons.push(`only ${candidates} live candidate(s) observed (need ≥${minCandidates}) — extend the window`);
  }
  if (windowHours < minWindowHours) {
    reasons.push(`observation window ${windowHours.toFixed(1)}h < ${minWindowHours}h`);
  }
  if (disagreed > 0) {
    reasons.push(`${disagreed} candidate(s) a human DISAGREED with — auto-clear unsafe`);
  }
  // Every observed candidate must be affirmatively human-reviewed and agreed.
  if (candidates > 0 && agreed < candidates) {
    reasons.push(`${candidates - agreed} candidate(s) not yet human-reviewed as 'agree'`);
  }

  const clean = candidates >= minCandidates
    && windowHours >= minWindowHours
    && disagreed === 0
    && agreed === candidates
    && candidates > 0;

  return {
    verdict: clean ? 'clean' : 'insufficient-evidence',
    candidates,
    reviewed: reviewed.length,
    agreed,
    disagreed,
    windowHours,
    reasons,
  };
}

module.exports = {
  SHADOW_MIN_WINDOW_HOURS,
  SHADOW_MIN_CANDIDATES,
  wouldAutoClear,
  shadowObservation,
  assessShadowEvidence,
};
