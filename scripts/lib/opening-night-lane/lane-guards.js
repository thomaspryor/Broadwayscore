'use strict';
/**
 * Non-review and roundup checks the lane runs on a fetched review BEFORE it is scored (BRO-6872).
 *
 * The lane bypasses the write path's nonReview and roundupUrlSwap guards (trust-model LANE_BYPASSED_GUARDS), because
 * those judge stored files and would stand down for a lane row anyway. That let the 2026-10 replays score Gold Derby's
 * "what the critics say" roundups as Ethan Alter reviews of both shows. This applies the same detectors the regular
 * path uses, the shared functions themselves, to the page the lane fetched:
 *   - namedNonReviewReason   (non-review-url-patterns.js; e.g. Gold Derby awards news and interviews)
 *   - isRoundupPageAsReview  (review-guards.js; review-file-writer E0, e.g. Gold Derby /theater/YYYY/*-reviews/)
 *   - detectRoundupDigest    (roundup-digest.js; review-file-writer E3)
 *   - detectPullQuoteCompilation (roundup-digest.js; review-file-writer E4: a page quoting several other outlets)
 * It returns a reason, or null; it sets no flag on any record (the lane drops the row before a file exists).
 */
const { namedNonReviewReason } = require('../non-review-url-patterns');
const { isRoundupPageAsReview, isRoundupUrl } = require('../review-guards');
const { detectRoundupDigest, detectPullQuoteCompilation } = require('../roundup-digest');
const { PROVENANCE_KEY } = require('./trust-model');

/**
 * @param {{url: string, outletId?: string, fullText?: string, criticName?: string}} row (a lane row; its provenance
 *   source decides how wide the named URL patterns apply)
 * @returns {string|null} why the page is not one critic's review, or null
 */
function laneNonReviewReason(row) {
  if (!row || !row.url) return null;
  // As explainExclusion does for stored files: host-wide patterns apply only to unvetted discovery; a link an aggregator
  // cited as a review is held to the allSources patterns alone.
  const prov = row[PROVENANCE_KEY];
  const named = namedNonReviewReason(row.url, { allSourcesOnly: !!(prov && prov.source === 'aggregator') });
  if (named) return `named non-review URL (${named})`;
  // A row without an outletId still gets the outlet-keyed roundup checks (the url names the outlet).
  let outletId = row.outletId || '';
  if (!outletId) { try { outletId = (require('../review-normalization').resolveOutletFromUrl(row.url) || {}).outletId || ''; } catch { /* keep '' */ } }
  const rec = { url: row.url, outletId, fullText: row.fullText || '', criticName: row.criticName || '' };
  if (isRoundupPageAsReview(rec)) return `roundup page (${isRoundupUrl(row.url).reason || 'roundup URL'})`;
  if (/\/article\/Review-Roundup-/i.test(row.url) || /\/news\/post\/(?:review-round[-_ ]?up)/i.test(row.url)) return 'roundup page (URL pattern)';
  if (rec.fullText) {
    const digest = detectRoundupDigest(rec);
    if (digest) return `roundup digest (${digest.reason})`;
    const compilation = detectPullQuoteCompilation(rec);
    if (compilation) return `pull-quote compilation (${compilation.reason})`;
  }
  return null;
}

module.exports = { laneNonReviewReason };
