'use strict';

// Disk-aware "already found" outlet detection, shared between
// opening-night-poller.js and gather-reviews.js. Both callers need to know
// which outlets already have a scored/kept review FILE on disk for a show —
// not just what the current run's in-memory accumulator has seen — so a
// second/third sweep (backfill, gap-closure, scheduled re-run) doesn't
// re-query site-search/SERP for outlets it already has real files for (#785).

const fs = require('fs');
const path = require('path');
const { isLondonMarket } = require('./venue-classification');
const { isBlockedReviewUrl } = require('./domain-filters');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', '..', 'data', 'review-texts');

// S1-T5: discovery-unblock window. A file only stops suppressing rediscovery
// via the canonical isRejectedNonReview path when its show is within ±45d of
// previews/opening AND the outlet is T1/T2 — this bounds the SERP-volume blast
// radius (dry-run measured 1 newly-unblocked cell corpus-wide). Outside the
// window / for T3+ outlets, the historical skip conditions apply unchanged.
const DISCOVERY_UNBLOCK_WINDOW_DAYS = 45;

// Canonical "has a real score" check — mirrors rebuild-helpers.js:getBestScore's
// priority list (human -> adjudicated -> originalScore -> llmScore -> assignedScore
// -> aggregatorStars). A narrower check here (e.g. llmScore/assignedScore only)
// misses aggregator-star-scored reviews (originalScore/aggregatorStars) and would
// treat a genuinely scored review as unscored (#1328 fixup — a classify script using
// this narrower check corrupted 16 real show-score/timeout/thestage reviews).
function isScoredReviewFile(data) {
  return require('./review-guards').hasValidScore(data);
}

function isInDiscoveryUnblockWindow(show, nowMs = Date.now()) {
  if (!show) return false;
  const anchor = show.previewsStartDate || show.openingDate;
  if (!anchor) return true; // dateless active show — poller only runs on live shows
  const ms = new Date(anchor).getTime();
  if (isNaN(ms)) return true;
  return Math.abs(nowMs - ms) <= DISCOVERY_UNBLOCK_WINDOW_DAYS * 86400000;
}

/**
 * Get found outlet IDs for a show (from existing review-text files on disk).
 * @param {string} showId
 * @param {{show?: object, market?: string}} [ctx] - when provided, in-window
 *   T1/T2 rejected-non-review files (interview/feature/preview/news, garbage,
 *   invalid tier) also stop blocking rediscovery (S1-T5). Omit for the historical
 *   behavior (used by non-poller callers).
 */
function getFoundOutletIds(showId, ctx) {
  const outletIds = new Set();
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return outletIds;

  const scoped = !!(ctx && ctx.show && isInDiscoveryUnblockWindow(ctx.show));
  let isRejectedNonReview, getTier, showCategory;
  if (scoped) {
    ({ isRejectedNonReview } = require('./review-guards'));
    ({ getTier } = require('./outlet-tiers'));
    showCategory = isLondonMarket(ctx.market) ? 'west-end' : 'broadway';
  }

  for (const file of fs.readdirSync(showDir)) {
    if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      // Skip wrongProduction/wrongShow files — they shouldn't block re-discovery
      // Skip confirmed non-reviews (interviews, news, previews) — same reason
      if (data.wrongProduction || data.wrongShow || data.rejectionReason === 'not_a_review') continue;
      // #1328: isScoreable() filters isBlockedReviewUrl URLs (aggregator/listing/
      // ticket/social domain) out before the LLM ensemble ever runs, so these files
      // sit unscored AND unclassified forever — no rejectionReason ever gets written.
      // The URL itself proves the outlet's real review was never actually collected,
      // so treat it the same as rejectionReason='not_a_review': don't let it mask
      // the outlet slot from SERP/gap rediscovery.
      if (data.url && !isScoredReviewFile(data) && isBlockedReviewUrl(data.url)) continue;
      // S1-T5: in-window T1/T2 — reopen discovery for a rejected non-review
      // (garbage / invalid tier / CV interview-feature-preview-news) so its
      // outlet slot doesn't read as "found". !isScored preserves the scored-
      // wrongProd carve-out (isRejectedNonReview excludes wrongProduction).
      if (scoped && data.outletId) {
        const isScored = (data.llmScore && data.llmScore.score != null) || data.humanReviewScore != null;
        if (!isScored && getTier(data.outletId.toLowerCase(), { showCategory }) <= 2
            && isRejectedNonReview(data)) continue;
      }
      if (data.outletId) outletIds.add(data.outletId.toLowerCase());
    } catch {}
  }
  return outletIds;
}

module.exports = { getFoundOutletIds, isInDiscoveryUnblockWindow, DISCOVERY_UNBLOCK_WINDOW_DAYS, REVIEW_TEXTS_DIR };
