'use strict';

/**
 * late-star-anchor.js — detect reviews that were scored UNANCHORED (llm-v6, no
 * band) but now carry a HIGH-reliability published star, so they should be
 * re-scored in ANCHORED mode (LLM constrained to the star's band).
 *
 * Why (2026-06-30): on opening nights the review text is scraped and LLM-scored
 * immediately — before the outlet's star widget is scraped. With no star present
 * `detectBandFromReviewFile` returns no high-reliability band, so the ensemble
 * scores `llm-v6` (unanchored, full-range — a 3/5 review can land at 77). The star
 * arrives minutes/hours later but nothing re-scores the review, and re-runs
 * explicitly skip `llm-v6`. Result: 38 WE reviews stuck unanchored with scores
 * outside their published star's band. The anchored system itself works (WE/OWE
 * auto-anchor when a star IS present at scoring time) — this only closes the
 * late-arriving-star race by flagging such reviews for an anchored re-score.
 *
 * Pure: reuses the SAME detector the scorer uses (detectBandFromReviewFile), so a
 * positive here guarantees the re-score will anchor. Caller flags needsRescore +
 * rescoreReason='late-star-anchor' and runs:
 *   index.ts --needs-rescore --rescore-reason=late-star-anchor
 *
 * Inclusion MUST match the consumer. The scorer's --needs-rescore filter requires
 * isScoreable → isIncludableForRebuild (index.ts:817). Flagging a review the scorer
 * rejects (duplicate, consent-wall stub, isNonReview, …) sets a needsRescore that
 * NEVER clears — it can't be scored, so the flag persists and the queue accumulates
 * stuck entries every cron (5 such found 2026-06-30: 3 duplicateOf, 2 stub/invalid
 * consent walls). So gate on the canonical isIncludableForRebuild here, not a
 * hand-rolled subset (memory/feedback_includability_predicates_must_be_canonical).
 */

const { detectBandFromReviewFile, shouldUseAnchoredMode, LOW_RELIABILITY_EXTRACTION } = require('./star-reliability');
const { isIncludableForRebuild } = require('./review-guards');

/**
 * @param {object} data - review-text record
 * @param {object} [ctx]
 * @param {string} [ctx.category] - the show's market/category (west-end, off-west-end,
 *   broadway, ...). Required to scope to ANCHORED markets — llm-v6 + a high-rel star
 *   is only a bug where anchoring is ACTIVE (WE/OWE auto-anchor). On Broadway (not
 *   migrated) llm-v6 is the expected output and must NOT be re-anchored.
 * @param {object} [ctx.show] - { title } for the show; forwarded to isIncludableForRebuild
 *   (enables its wrongShow stale-flag override). Falls back safely when omitted.
 * @param {string} [ctx.filePath] - review file path; forwarded to isIncludableForRebuild
 *   for its path-based cross-show checks. Optional.
 * @returns {{ band: object, starsRaw: string } | null} the band to anchor to, or null
 */
function needsLateStarReanchor(data, ctx = {}) {
  if (!data || data.scoreSource !== 'llm-v6') return null;
  // A manual/human override is includable but must not be disturbed (human wins).
  if (data.humanReviewScore != null) return null;
  // Canonical inclusion gate — same predicate the scorer applies. Subsumes wrong-*,
  // roundup, duplicateOf, isNonReview, stub/invalid-content; prevents stuck-flag
  // accumulation on reviews that can never be re-scored (see header).
  if (!isIncludableForRebuild(data, ctx.show, ctx.filePath)) return null;
  // Only anchored markets (WE/OWE, or env-flagged) — elsewhere llm-v6 is expected.
  const category = ctx.category != null ? ctx.category : data.category;
  if (!shouldUseAnchoredMode({ category, envFlag: process.env.ANCHORED_BANDS_PILOT === '1' })) return null;
  // Reliability MUST be judged from the EXTRACTION source (originalScoreSource).
  // isHighReliabilityStar()/detectBandFromReviewFile() key off data.scoreSource,
  // which for a late star is 'llm-v6' (the final source) — so they'd wrongly call
  // a numeric-stars/css-stars extraction high-reliability. Gate here so we never
  // re-anchor an FP-prone star (2026-06-30).
  if (LOW_RELIABILITY_EXTRACTION.has(data.originalScoreSource)) return null;
  const det = detectBandFromReviewFile(data);
  if (det && det.band) {
    return { band: det.band, starsRaw: det.starsRaw };
  }
  return null;
}

module.exports = { needsLateStarReanchor };
