'use strict';
/**
 * multishow-rescore-flag (BRO-5294): mark a review file for rescoring because
 * its stored body is a multi-review column and the scorer now reads only the
 * target show's section (scripts/llm-scoring/venue-box-sections.ts).
 */
const { markRescoreNeeded } = require('./rescore-flagging');

const RESCORE_REASON = 'multi-show column: score the target section (BRO-5294)';
const BLOCKING = ['wrongAttribution', 'isNonReview', 'duplicateOf', 'wrongShow', 'wrongProduction', 'isSyndicatedDuplicate', '_locked'];

/** Returns { ok, reason } and mutates data when ok. */
function flagMultiShowRescore(data, flaggedAt) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'no data' };
  const blocked = BLOCKING.find((k) => data[k]);
  if (blocked) return { ok: false, reason: `skipped: ${blocked}` };
  if (data.contentTier !== 'complete' || String(data.fullText || '').length < 1500) return { ok: false, reason: 'skipped: not a complete body' };
  if (!(data.llmScore && data.llmScore.score)) return { ok: false, reason: 'skipped: never scored' };
  // Only a column carries two or more production boxes "($lo-$hi)"; the scorer
  // (venue-box-sections.ts) decides the section, this only refuses plain reviews.
  if ((String(data.fullText).match(/\(\$\s?\d/g) || []).length < 2) return { ok: false, reason: 'skipped: fewer than 2 production boxes' };
  if (data.humanReviewScore && data.humanReviewScoreProvisional !== true) return { ok: false, reason: 'skipped: locked human score' };
  markRescoreNeeded(data, RESCORE_REASON, flaggedAt, { requeue: true });
  return { ok: true, reason: 'flagged' };
}

module.exports = { flagMultiShowRescore, RESCORE_REASON };
