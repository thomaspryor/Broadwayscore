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
  if (!data) return null;
  // Already anchored. Check llmScore.band, NOT scoreSource — later star
  // extraction overwrites scoreSource with the extraction label (e.g.
  // 'telegraph-svg-stars'), but llmScore.band is only ever written by the
  // anchored scorer, so it survives and prevents a re-flag/re-score loop.
  if (data.scoreSource === 'anchored-v6') return null;
  if (data.llmScore && data.llmScore.band) return null;
  const isV6Unanchored = data.scoreSource === 'llm-v6';
  // Non-v6 stamps (2026-07-11 extension): a file whose scoreSource is an
  // extraction label (unicode-stars, json-ld, guardian-api, …) but which
  // carries an ensemble LLM verdict was either scored pre-v6 or had its v6
  // stamp overwritten by a later star extraction. Either way the rebuild
  // serves the star-flat conversion (P0.5) instead of a within-band
  // sentiment score — re-anchor it. Files with no ensemble LLM at all are
  // left alone: unscored ones drain via the normal scoring queue, and
  // excerpt-less star-only files have no prose to sentiment-read.
  if (!isV6Unanchored) {
    if (!(data.llmScore && typeof data.llmScore.score === 'number' && data.ensembleData)) return null;
  }
  // A manual/human override is includable but must not be disturbed (human wins).
  if (data.humanReviewScore != null) return null;
  // Adjudicated verdicts win at read time (P0a) — rescoring is wasted spend.
  if (data.adjudicatedScore != null) return null;
  // Canonical inclusion gate — same predicate the scorer applies. Subsumes wrong-*,
  // roundup, duplicateOf, isNonReview, stub/invalid-content; prevents stuck-flag
  // accumulation on reviews that can never be re-scored (see header).
  if (!isIncludableForRebuild(data, ctx.show, ctx.filePath)) return null;
  // Only anchored markets (WE/OWE, or env-flagged) — elsewhere llm-v6 is expected.
  const category = ctx.category != null ? ctx.category : data.category;
  if (!shouldUseAnchoredMode({ category, envFlag: process.env.ANCHORED_BANDS_PILOT === '1' })) return null;
  if (isV6Unanchored) {
    // Reliability MUST be judged from the EXTRACTION source (originalScoreSource).
    // isHighReliabilityStar()/detectBandFromReviewFile() key off data.scoreSource,
    // which for a late star is 'llm-v6' (the final source) — so they'd wrongly call
    // a numeric-stars/css-stars extraction high-reliability. Gate here so we never
    // re-anchor an FP-prone star (2026-06-30).
    if (LOW_RELIABILITY_EXTRACTION.has(data.originalScoreSource)) return null;
  }
  const det = detectBandFromReviewFile(data);
  if (det && det.band) {
    // For non-v6 stamps the scoreSource IS the extraction label, so
    // det.highReliability (isHighReliabilityStar on scoreSource) is the
    // correct gate — never re-anchor onto an FP-prone extraction.
    if (!isV6Unanchored && !det.highReliability) return null;
    return { band: det.band, starsRaw: det.starsRaw };
  }
  return null;
}

module.exports = { needsLateStarReanchor };
