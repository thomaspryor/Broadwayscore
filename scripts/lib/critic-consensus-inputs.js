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
 * @param {{show?: object, filePath?: string, isScoreable?: (data: object, show?: object, filePath?: string) => boolean}} [ctx]
 *   the shows.json row, the file's path and the scorer's own predicate (scripts/lib/is-scoreable.js,
 *   injected for the same write-free reason as normalizeOutlet). With both, a file the scorer and
 *   the rebuild drop (duplicateOf pointing at a live twin, syndication copy, a wrongProduction the
 *   scorer would not clear) is not fed to the LLM either (BRO-6226).
 */
function reviewTextInput(data, showId, liveOutlets = null, normalizeOutlet = null, ctx = {}) {
  if (!data || typeof data !== 'object') return null;
  // Skip excluded reviews
  if (data.duplicateOf || data.wrongProduction || data.wrongShow || data.wrongAttribution ||
      data.isRoundupArticle || data.rejectionReason || data.contentTier === 'invalid') return null;
  // BRO-6226: the scorer's predicate, not a hand-kept subset of it.
  if (ctx.isScoreable && ctx.filePath && !ctx.isScoreable(data, ctx.show, ctx.filePath)) return null;
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
 * With opts.isScoreable and opts.createDedup (the generator passes
 * scripts/lib/is-scoreable.js and scripts/lib/within-show-dedup.js), files go
 * through the scorer's predicate and then the rebuild's within-show dedup
 * (same URL, same outlet+critic, an unknown-critic stub beside a named
 * critic), named critics first, so a live outlet's duplicate stubs are not
 * counted or summarised twice (BRO-6226: Benjamin Button had 30 inputs for 27
 * published reviews). Both are injected, not required, because the
 * contamination audit sharing this module must stay write-free across its
 * require graph and review-guards is not; the audit runs without them, so its
 * drift count can sit a few rows above the generator's (thresholds are 10/15).
 * @param {{reviewTextsDir?: string, onWarn?: (msg: string) => void, normalizeOutlet?: (name: string) => string, show?: object,
 *   isScoreable?: (data: object, show?: object, filePath?: string) => boolean,
 *   createDedup?: () => {isDuplicate: (data: object) => boolean, add: (data: object) => void}}} [opts]
 * @returns {object[]}
 */
function loadReviewTexts(showId, liveOutlets = null, opts = {}) {
  const dir = path.join(opts.reviewTextsDir || DEFAULT_REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return [];
  const reviews = [];
  const dedup = opts.createDedup ? opts.createDedup() : null;
  for (const file of fs.readdirSync(dir).filter(f => isReviewTextFile(f)).sort(namedBeforeUnknown)) {
    try {
      const filePath = path.join(dir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const row = reviewTextInput(data, showId, liveOutlets, opts.normalizeOutlet || null, { show: opts.show, filePath, isScoreable: opts.isScoreable });
      if (!row || (dedup && dedup.isDuplicate(data))) continue;
      if (dedup) dedup.add(data);
      reviews.push(row);
    } catch (err) {
      if (opts.onWarn) opts.onWarn(`Failed to parse ${file}: ${err.message}`);
    }
  }
  return reviews;
}

const UNKNOWN_FILE_RE = /--(unknown|unnamed)\b/i;
/** Named-critic files before unknown stubs, then by name (the rebuild's dedup order). */
function namedBeforeUnknown(a, b) {
  return Number(UNKNOWN_FILE_RE.test(a)) - Number(UNKNOWN_FILE_RE.test(b)) || a.localeCompare(b);
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
  // Internal change-detection fingerprint over raw score bands. Not shown to
  // readers, and the generator inputs carry no verdict (BRO-6729: user-facing
  // counters use the verdict via scripts/lib/review-breakdown.js).
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
