'use strict';

/**
 * critic-consensus-inputs.js: what generate-critic-consensus.js summarises,
 * and the fingerprint it stores, in one place (BRO-4869).
 *
 * The generator writes reviewCount/meanScore into data/critic-consensus.json
 * from the review TEXTS it could read (loadReviewTexts below). The contamination
 * audit used to compare those numbers against every scored reviews.json row,
 * so a text-light show (West End star-rated rows with no readable text) read
 * as permanent drift: glass-kill-bluebeard-and-imp-west-end-2019 "4 vs 16",
 * grease-2007 "mean 33 vs 53", although regenerating would write the same
 * numbers again. Both sides now build the same inputs and the same fingerprint
 * from this module, so the audit compares like with like.
 */

const { isReviewTextFile } = require('./review-text-sidecars');
const fs = require('fs');
const path = require('path');

const DEFAULT_REVIEW_TEXTS_DIR = path.join(__dirname, '..', '..', 'data', 'review-texts');

/** Review-text excerpt fields used when a file has no fullText. */
const EXCERPT_FIELDS = ['dtliExcerpt', 'bwwExcerpt', 'showScoreExcerpt', 'nycTheatreExcerpt', 'lboRoundupExcerpt'];

/**
 * The generator's input row for one review-text file, or null when the file
 * is excluded or carries no text.
 * @param {object} data parsed review-text JSON
 * @param {string} showId
 * @param {Set<string>|null} liveOutlets `${showId}|${outletId}` keys (liveOutletKeys), or null for no filter
 * @param {((name: string) => string)|null} [normalizeOutlet] alias resolver (review-normalization's). Injected, not
 *   required here: the audit that shares this module must stay write-free across its require
 *   graph (safe-form allowlist), and review-normalization pulls in exclusion-logger.
 */
function reviewTextInput(data, showId, liveOutlets = null, normalizeOutlet = null) {
  if (!data || typeof data !== 'object') return null;
  // Skip excluded reviews
  if (data.duplicateOf || data.wrongProduction || data.wrongShow || data.wrongAttribution ||
      data.isRoundupArticle || data.rejectionReason || data.contentTier === 'invalid') return null;
  // Only outlets the site actually shows for this show: the rebuild's guards
  // exclude more than the flags above, and a Critics' Take written from an
  // excluded review (another production, another show) is wrong on the page
  // (BRO-4852; 858 such inputs across 1,289 takes on 2026-10-08). Same outlet
  // normalisation the rebuild applies to reviews.json rows
  // (rebuild-all-reviews.js normalizeOutletCanonical), so an alias such as
  // metro -> metro-uk still matches.
  if (liveOutlets && !liveOutlets.has(`${showId}|${data.outletId}`)
      && !(normalizeOutlet && liveOutlets.has(`${showId}|${normalizeOutlet(data.outletId || data.outlet)}`))) return null;

  // Collect all available text (prefer full text, fall back to excerpts)
  const textParts = data.fullText ? [data.fullText] : EXCERPT_FIELDS.map(f => data[f]).filter(Boolean);
  if (textParts.length === 0) return null;
  return {
    outlet: data.outlet,
    critic: data.criticName,
    text: textParts.join('\n\n'),
    score: data.assignedScore,
    publishDate: data.publishDate,
    hasFullText: !!data.fullText,
  };
}

/**
 * Review texts the generator summarises for a show.
 * @param {string} showId
 * @param {Set<string>|null} liveOutlets
 * @param {{reviewTextsDir?: string, onWarn?: (msg: string) => void, normalizeOutlet?: (name: string) => string}} [opts]
 * @returns {object[]}
 */
function loadReviewTexts(showId, liveOutlets = null, opts = {}) {
  const dir = path.join(opts.reviewTextsDir || DEFAULT_REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return [];
  const reviews = [];
  for (const file of fs.readdirSync(dir).filter(f => isReviewTextFile(f))) {
    try {
      const row = reviewTextInput(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')), showId, liveOutlets, opts.normalizeOutlet || null);
      if (row) reviews.push(row);
    } catch (err) {
      if (opts.onWarn) opts.onWarn(`Failed to parse ${file}: ${err.message}`);
    }
  }
  return reviews;
}

/** Positive >= 61, mixed 40-60, negative < 40 (generator's buckets). */
function bucketOf(score) {
  if (score >= 61) return 'positive';
  if (score >= 40) return 'mixed';
  return 'negative';
}

/**
 * The change-detection fingerprint the generator stores beside each take.
 * @param {{score?: number|null, hasFullText?: boolean}[]} reviews generator inputs
 * @returns {{reviewCount: number, fullTextCount: number, meanScore: number|null, bucketBreakdown: {positive: number, mixed: number, negative: number}}}
 */
function consensusFingerprint(reviews) {
  const rows = reviews || [];
  const scored = rows.filter(r => typeof r.score === 'number');
  const bucketBreakdown = { positive: 0, mixed: 0, negative: 0 };
  for (const r of scored) bucketBreakdown[bucketOf(r.score)]++;
  return {
    reviewCount: rows.length,
    fullTextCount: rows.filter(r => r.hasFullText).length,
    meanScore: scored.length ? Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length) : null,
    bucketBreakdown,
  };
}

const REVIEWCOUNT_DRIFT_THRESHOLD = 10;
const MEANSCORE_DRIFT_THRESHOLD = 15;

/**
 * Audit drift flags between a stored take and the inputs it would be
 * regenerated from today. `current` must be built the way the generator built
 * `stored` (consensusFingerprint over loadReviewTexts), otherwise the gap is
 * the source mismatch, not staleness.
 * @param {{reviewCount?: number, meanScore?: number|null}} stored
 * @param {{reviewCount: number, meanScore: number|null}} current
 * @returns {string[]}
 */
function consensusDriftFlags(stored, current) {
  const flags = [];
  if (!stored || !current) return flags;
  const storedCount = stored.reviewCount || 0;
  const rcDiff = Math.abs(storedCount - current.reviewCount);
  if (rcDiff >= REVIEWCOUNT_DRIFT_THRESHOLD) {
    flags.push(`REVIEWCOUNT_DRIFT:consensus=${storedCount},actual=${current.reviewCount},diff=${rcDiff}`);
  }
  // No stored or current mean = nothing to drift from (generator's own guard).
  if (stored.meanScore != null && current.meanScore != null) {
    const msDiff = Math.abs(stored.meanScore - current.meanScore);
    if (msDiff >= MEANSCORE_DRIFT_THRESHOLD) {
      flags.push(`MEANSCORE_DRIFT:consensus=${stored.meanScore},actual=${Math.round(current.meanScore)},diff=${Math.round(msDiff)}`);
    }
  }
  return flags;
}

module.exports = {
  DEFAULT_REVIEW_TEXTS_DIR,
  REVIEWCOUNT_DRIFT_THRESHOLD,
  MEANSCORE_DRIFT_THRESHOLD,
  reviewTextInput,
  loadReviewTexts,
  bucketOf,
  consensusFingerprint,
  consensusDriftFlags,
};
