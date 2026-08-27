/**
 * Consolidated false-positive signal detection for wrongProduction:true
 * review-text records (BRO-23).
 *
 * Two independent FP modes, both READ-ONLY (no flag is ever cleared here —
 * every hit still needs a human/live-page check before correction):
 *
 *   1. 'misparsed-date' — a date-guard flag whose own in-file corroboration
 *      (Theatre Record archive month, current-run roundup excerpt) contradicts
 *      the date that got it flagged. Delegates to the already-calibrated
 *      evaluateCurrentRunCorroboration() (care-west-end-2026 incident,
 *      2026-07-11) — this module does not re-derive that signal.
 *
 *   2. 'truncated-reason' — wrongProductionReason was hard-cut mid-sentence.
 *      Confirmed root cause: rebuild-all-reviews.js writes
 *      `CV-promoted: ${cv.reasoning.substring(0, 200)}` with no regard for
 *      sentence boundaries. gypsy-2024/culturesauce--thom-geier.json: reason
 *      ends "...However, the review explicitl" (cut mid-word), while CV's own
 *      full `reasoning` field affirmatively states this IS "definitively a
 *      review of the Broadway Gypsy production ... with Audra McDonald" — the
 *      flag rests on a rationale a human can't even finish reading without
 *      digging into contentVerification.reasoning separately. A truncated
 *      reason is reported as a candidate regardless of whether the untruncated
 *      text would still support the flag; the sweep is a finder, not a fixer.
 *
 * Corroboration guard: a flag a human already adjudicated
 * (humanReviewedWrongProduction / wrongProductionProvenance:'manual' /
 * humanReviewScore) is never surfaced as a candidate by either signal — same
 * rule contradicted-flag-basis.js applies, reused via hasHumanAssertedFlag()
 * rather than re-derived.
 *
 * Pure module: no fs, no process, no side effects.
 */

'use strict';

const { evaluateCurrentRunCorroboration, bucketDateGuardCandidate } = require('./wrong-production-corroboration');
const { hasHumanAssertedFlag } = require('./contradicted-flag-basis');

// Most wrongProductionReason values in the corpus are terse operator/audit
// notes ("URL mentions Almeida Theatre but show is at Ambassadors Theatre
// (venue-mismatch guard)", "cross-production-audit") that never end in a
// period — "missing terminal punctuation" alone is not a truncation signal
// here (a first pass at this sweep produced 1500+ false hits on exactly that
// heuristic). The real, corpus-confirmed bug is narrower: rebuild-all-
// reviews.js and collect-review-texts.js both stamp
// `${prefix}${cv.reasoning.substring(0, 200)}` with no regard for sentence
// boundaries — so the signal is "starts with a known CV-promotion prefix AND
// the reasoning portion is exactly 200 chars" (the substring cap), not
// "prose that doesn't end in punctuation".
const TRUNCATION_PREFIX_PATTERNS = [
  /^(?:CV-promoted|CV-low-but-strong-signal): /,
  /^Collector LLM: wrong production \([^)]*\) — /,
];

// A sentence-ending mark, optionally followed by a closing quote/paren.
const TERMINAL_PUNCTUATION_RE = /[.!?][)"'”’]*\s*$/;

const TRUNCATION_CAP = 200;

/**
 * Strip a known CV-promotion prefix and return the reasoning-only remainder,
 * or null if `reason` doesn't start with one of them.
 */
function _stripTruncationPrefix(reason) {
  for (const re of TRUNCATION_PREFIX_PATTERNS) {
    const m = re.exec(reason);
    if (m) return reason.slice(m[0].length);
  }
  return null;
}

/**
 * @param {*} reason - review.wrongProductionReason
 * @returns {boolean} true if `reason` was hard-cut at the writers' 200-char
 *   `.substring(0, 200)` cap mid-sentence.
 */
function isTruncatedReason(reason) {
  if (typeof reason !== 'string') return false;
  const remainder = _stripTruncationPrefix(reason.trim());
  if (remainder === null) return false;
  // .substring(0, 200) always yields exactly 200 chars when the source was
  // longer — a naturally-written CV reasoning happening to land on exactly
  // 200 chars by chance is vanishingly unlikely, especially combined with no
  // terminal punctuation at that exact cutoff.
  if (remainder.length !== TRUNCATION_CAP) return false;
  if (TERMINAL_PUNCTUATION_RE.test(remainder)) return false;
  return true;
}

/**
 * Classify a single wrongProduction:true review-text record as an FP sweep
 * candidate, or null if the corroboration guard clears it.
 *
 * @param {object} args
 * @param {object} args.review - parsed review-text record
 * @param {object} args.show - the show record this review is filed under
 * @returns {null | {
 *   kind: 'misparsed-date' | 'truncated-reason',
 *   strength: 'strong' | 'weak',
 *   signals: string[],
 *   fullReasoning: string | null,
 * }}
 */
function classifyWrongProductionFPCandidate({ review, show } = {}) {
  if (!review || review.wrongProduction !== true) return null;
  if (hasHumanAssertedFlag(review)) return null;

  const note = review.wrongProductionNote || '';
  if (note.startsWith('Date guard:')) {
    const isBeforePreview = / is \d+d before /.test(note);
    const corrob = evaluateCurrentRunCorroboration({ review, show });
    const bucket = bucketDateGuardCandidate({ corrob, isBeforePreview });
    if (bucket) {
      return { kind: 'misparsed-date', strength: bucket, signals: corrob.signals, fullReasoning: null };
    }
    // null bucket: no corroboration, or an informational-only 'strong' (see
    // bucketDateGuardCandidate) — fall through in case the truncated-reason
    // signal also applies.
  }

  const reason = review.wrongProductionReason || '';
  if (isTruncatedReason(reason)) {
    const cv = review.contentVerification;
    const fullReasoning = (cv && typeof cv.reasoning === 'string' && cv.reasoning.length > reason.length)
      ? cv.reasoning
      : null;
    return {
      kind: 'truncated-reason',
      // 'strong': the full untruncated rationale is recoverable from
      // contentVerification.reasoning without a live-page check.
      // 'weak': no fallback text exists — the flag's rationale is simply gone.
      strength: fullReasoning ? 'strong' : 'weak',
      signals: ['truncated-wrongProductionReason'],
      fullReasoning,
    };
  }

  return null;
}

module.exports = {
  isTruncatedReason,
  classifyWrongProductionFPCandidate,
};
