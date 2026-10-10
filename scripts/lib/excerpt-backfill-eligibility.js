/**
 * excerpt-backfill-eligibility.js — canonical "is this review a BRO-115
 * excerpt-only backfill candidate?" predicate.
 *
 * Task #501 fixed isIncludableForRebuild() to recognize excerpt fields
 * (bwwExcerpt/dtliExcerpt/etc), not just fullText — unlocking LLM-scoring
 * eligibility for a corpus-wide backlog of reviews that were previously
 * silently excluded: excerpt-only (fullText:null), unscored (no llmScore),
 * not flagged scraper_garbage. BRO-115 tracks backfilling that backlog.
 *
 * "Excerpt-only" is layered on top of, not reimplemented alongside,
 * isActionableUnscored() — the exact predicate the standing daily scoring
 * pipeline's cascade counter uses (scripts/lib/scoring-queue-counts.js,
 * task #652). An earlier version of this file re-composed isScoreable/
 * selectScorableText/isBlockedFromRescore by hand and silently dropped two
 * of isActionableUnscored's own gates (manual_extracted_star_rating
 * authoritative-star skip, isInFallbackCooldown) — a ship-check adversarial
 * pass caught it flagging files the scorer would never touch. Delegating
 * closes that gap structurally: any future gate added to
 * isActionableUnscored is inherited here for free, matching the project rule
 * that includability predicates must be canonical
 * (memory/feedback_includability_predicates_must_be_canonical.md).
 */

const { hasExcerpt } = require('./excerpt-fields');
const { isActionableUnscored } = require('./scoring-queue-counts');

/**
 * @param {Object} data - review-text record
 * @param {Object} [ctx] - forwarded verbatim to isActionableUnscored
 * @param {Object} [ctx.show] - `{ title }`
 * @param {string} [ctx.showTitle]
 * @param {string} [ctx.filePath]
 * @returns {boolean} true when this file is excerpt-only and the standing
 *   daily scoring pipeline would actually act on it right now
 */
function isExcerptOnlyBackfillCandidate(data, ctx) {
  if (!data) return false;
  // "Excerpt-only" per BRO-115's own definition: no fullText at all, but at
  // least one aggregator excerpt field present.
  if (data.fullText && data.fullText.trim()) return false;
  if (!hasExcerpt(data)) return false;
  return isActionableUnscored(data, ctx);
}

module.exports = { isExcerptOnlyBackfillCandidate };
