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
 * This module composes the same canonical predicates the production scorer
 * and its queue counter already use (isScoreable, selectScorableText,
 * isBlockedFromRescore — see scripts/lib/scoring-queue-counts.js, which this
 * mirrors but scopes to excerpt-only files specifically) so a file is never
 * double-counted as "still needs backfill" once the standing daily scoring
 * pipeline (llm-ensemble-score.yml, --unscored-only) has actually picked it
 * up or correctly excluded it for an unrelated reason (wrongShow, duplicateOf,
 * no scorable text, etc).
 */

const { isScoreable } = require('./is-scoreable');
const { hasExcerpt } = require('./excerpt-fields');
const { isBlockedFromRescore } = require('./rescore-lifecycle');
const { selectScorableText } = require('./scorable-text');

/**
 * @param {Object} data - review-text record
 * @param {Object} [ctx]
 * @param {Object} [ctx.show] - `{ title }`, forwarded to isScoreable
 * @param {string} [ctx.showTitle] - forwarded to selectScorableText's content-quality check
 * @param {string} [ctx.filePath] - forwarded to isScoreable
 * @returns {boolean} true when this file is excerpt-only, unscored, and the
 *   production scorer would actually act on it right now
 */
function isExcerptOnlyBackfillCandidate(data, ctx) {
  const c = ctx || {};
  if (!data) return false;
  if (data.llmScore) return false;
  // "Excerpt-only" per BRO-115's own definition: no fullText at all, but at
  // least one aggregator excerpt field present.
  if (data.fullText && data.fullText.trim()) return false;
  if (!hasExcerpt(data)) return false;
  if (!isScoreable(data, c.show, c.filePath)) return false;
  if (isBlockedFromRescore(data)) return false;
  if (!selectScorableText(data, { showTitle: c.showTitle })) return false;
  return true;
}

module.exports = { isExcerptOnlyBackfillCandidate };
