'use strict';

/**
 * ingest-html-score.js — recover an outlet's explicit rating from page HTML
 * when a review is ingested WITH a normal body (BRO-4764).
 *
 * ingest-review-from-url.js used to run the outlet score extractors only when
 * body extraction came back empty (the paywalled UK star outlets). A normal
 * ingest wrote originalScore: null, so a rating carried only by the HTML — e.g.
 * 1minutecritic's <img alt="4 star review"> — was never recorded and the review
 * was scored by the LLM alone, with no star band (anchored-v6). Found on
 * slam-frank-off-broadway-2026 (Matthew Wexler, 4/5 scored 78 unanchored).
 *
 * Only outlets with a registered extractor are consulted, so generic
 * extractors cannot pull a stray "3/5" out of unrelated page chrome.
 *
 * @param {string} html      raw page HTML
 * @param {string} text      extracted article body
 * @param {string} outletId  canonical outlet id
 * @param {string} showTitle
 * @returns {{originalScore: string, normalizedScore: number, source: string}|null}
 */
function recoverScoreFromHtml(html, text, outletId, showTitle) {
  if (!html || !outletId) return null;
  const { extractScore, OUTLET_EXTRACTORS } = require('./score-extractors');
  if (!OUTLET_EXTRACTORS[outletId]) return null;
  return extractScore(html, text || '', outletId, showTitle) || null;
}

/**
 * True when an existing review file already carries a score signal, so a rating
 * freshly recovered from HTML must not be merged onto it. _mergeIntoExisting
 * fills each field independently when blank, so recovering onto a file with a
 * human/aggregator/LLM-era originalScore but no originalScoreNormalized or
 * originalScoreSource would pair the OLD score with the NEW extractor's
 * normalized value and source; the rebuild trusts the normalized value.
 * Mirrors the collector's skip (collect-review-texts.js: originalScore set).
 *
 * @param {object|null|undefined} existingData
 * @returns {boolean}
 */
function existingHasScoreSignal(existingData) {
  if (!existingData || typeof existingData !== 'object') return false;
  const has = (v) => v !== null && v !== undefined && v !== '';
  return has(existingData.originalScore)
    || has(existingData.aggregatorStars)
    || existingData.originalScoreCleared === true;
}

/**
 * True when a person or fix script deliberately cleared the existing file's
 * rating (originalScoreCleared). A score-only ingest (no article body) must not
 * put a recovered rating back on such a file: the with-body path already skips
 * via existingHasScoreSignal, the score-only path did not (BRO-5295).
 *
 * @param {object|null|undefined} existingData
 * @returns {boolean}
 */
function existingRatingCleared(existingData) {
  return !!existingData && typeof existingData === 'object' && existingData.originalScoreCleared === true;
}

/**
 * BRO-4042: record a merge that left a review file holding a body with no
 * score signal that the LLM scorer will also skip. Before this, a complete,
 * unflagged review merged into a poller-created canonical file could sit
 * unscored with no trace anywhere (Catarina, The Reviews Hub, 2026-09-22), and
 * triage-review-gap.js reported it as a gate rejection.
 *
 * A body with no score yet is the normal state of every review waiting for the
 * scoring cron, so this fires only when unscoredSkipReason (the scorer's own
 * selection filter, scripts/lib/scoring-queue-counts.js) says the file will NOT
 * be picked up. Emits a 'review-text-collected' stage-latency row tagged
 * reason 'merge-fulltext-no-score' with the skip reason, plus a warning.
 * Never throws.
 *
 * @param {object} review   the file's data as it landed on disk
 * @param {string} filepath
 * @param {{show?: object, submittedUrl?: string}} [ctx]  submittedUrl keys the
 *   row like the writer's review-first-seen row, even if the merge kept or
 *   upgraded a different url.
 * @returns {boolean} true when the row was emitted
 */
function auditMergedReviewWithoutScore(review, filepath, ctx = {}) {
  try {
    const { hasValidScore } = require('./review-guards');
    if (!review || typeof review.fullText !== 'string' || !review.fullText.trim()
        || hasValidScore(review)) return false;
    const { unscoredSkipReason } = require('./scoring-queue-counts');
    const show = ctx.show || null;
    const skipReason = unscoredSkipReason(review, {
      show, showTitle: show && show.title ? show.title : undefined, filePath: filepath,
    });
    if (skipReason === null) return false; // the scorer will pick it up
    const path = require('path');
    const { emitStage } = require('./stage-latency');
    const { normalizeCritic } = require('./review-normalization');
    emitStage({
      showId: review.showId,
      reviewKey: `${review.outletId}:${normalizeCritic(review.criticName)}:${ctx.submittedUrl || review.url || ''}`,
      stage: 'review-text-collected',
      metadata: {
        source: 'ingest-review-from-url',
        reason: 'merge-fulltext-no-score',
        skipReason,
        file: path.basename(filepath),
        outletId: review.outletId || null,
        contentTier: review.contentTier || null,
      },
    });
    console.warn(`  ⚠ Merged body has no score signal and the scorer will skip it (${skipReason}): ${filepath} (merge-fulltext-no-score; recorded in stage-latency log). It needs a recorded rating or a manual fix before it can count.`);
    return true;
  } catch (e) {
    process.stderr.write(`[ingest-html-score] no-score audit failed: ${e.message}\n`);
    return false;
  }
}

module.exports = { recoverScoreFromHtml, existingHasScoreSignal, existingRatingCleared, auditMergedReviewWithoutScore };
