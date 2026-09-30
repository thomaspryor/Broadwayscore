'use strict';

/**
 * paywall-stub-score.js — give a paywalled tier-1/2 review a score from a
 * rating we can SEE, instead of leaving it as an unscored stub (BRO-4431).
 *
 * A stub with no score never reaches the site. The Times, Sunday Times, FT,
 * the i and the Daily Mail wall their reviews, so the collector saves no text,
 * the ensemble has nothing to read, and the review silently disappears:
 * Cleansed (Times Clive Davis 1★, FT Sarah Hemming 3★), Golden Boy (Times
 * Clive Davis 3★, Sunday Times Patrick Kidd 5★), The Standard of Living.
 * Two ratings are visible without a subscription:
 *
 *   1. The critic's rating in the page's own structured data (schema.org
 *      reviewRating / ratingValue), served above the wall. Only structured
 *      sources count here: a star glyph sequence on a walled page is as
 *      likely to belong to a "related reviews" card as to the article.
 *   2. The rating an aggregator relays for that critic. theatre.reviews
 *      groups each critic under the star tier they published; checked against
 *      the 332 files where we ALSO have the outlet's own rating, it agreed 304
 *      times (most of the 28 misses are our own LLM-anchored scores, not
 *      published stars). The scorer already trusts a relayed rating for a
 *      known star outlet (rebuild-helpers getBestScore P0.5 'aggregatorStars-
 *      relay'), so the relay only has to land in `aggregatorStars`.
 *
 * Both are gap-fills: never over an existing originalScore/aggregatorStars, a
 * deliberately cleared score, or a file excluded as wrong show/production or
 * duplicate. The relay only applies to files WITHOUT a readable body (a full
 * text is scored by the ensemble; that decision is not changed here).
 * The Stage has its own walled-page path (walled-page-meta.js, BRO-4428).
 */

const { getTier } = require('./outlet-tiers');
const { KNOWN_STAR_OUTLETS, extractScore } = require('./score-extractors');

// A body shorter than this can't be scored by the ensemble (the rescore gate
// refuses it as body_too_short), so the file is a stub for our purposes.
const MIN_SCORABLE_CHARS = 1200;
const MAX_TIER = 2;
// Structured, article-scoped rating sources extractScore can return.
const STRUCTURED_SOURCES = new Set(['json-ld']);

function isMajorStarOutlet(outletId) {
  const id = String(outletId || '').toLowerCase();
  if (!id || id === 'thestage') return false;
  return KNOWN_STAR_OUTLETS.has(id) && getTier(id) <= MAX_TIER;
}

function hasScorableBody(data) {
  return typeof data.fullText === 'string' && data.fullText.trim().length >= MIN_SCORABLE_CHARS;
}

function isExcluded(data) {
  return data.wrongShow === true || data.wrongProduction === true || !!data.duplicateOf
    || data.isRoundupArticle === true;
}

function hasAnyScore(data) {
  return !!data.originalScore || data.originalScoreNormalized != null || !!data.aggregatorStars
    || !!data.originalScoreManual || data.originalScoreCleared === true
    || data.assignedScore != null || data.humanReviewScore != null
    || (data.llmScore && typeof data.llmScore.score === 'number');
}

/**
 * Why a relayed aggregator rating may or may not be applied to `data`.
 * Returns null when it may, else a short reason.
 */
function relayBlockReason(data, stars) {
  if (!data) return 'no-data';
  if (!isMajorStarOutlet(data.outletId)) return 'not-major-star-outlet';
  const n = Number(stars);
  if (!Number.isFinite(n) || n < 1 || n > 5) return 'no-stars';
  if (isExcluded(data)) return 'excluded';
  if (hasScorableBody(data)) return 'has-body';
  if (hasAnyScore(data)) return 'already-scored';
  return null;
}

/**
 * Patch for a relayed aggregator star rating (e.g. theatre.reviews "3 stars:
 * The Financial Times' Sarah Hemming"). Returns the fields to set, or null.
 */
function aggregatorStarsPatch(data, { stars, starsOutOf = 5, source }) {
  if (relayBlockReason(data, stars)) return null;
  if (Number(starsOutOf) !== 5) return null;
  return {
    aggregatorStars: `${Number(stars)}/5`,
    aggregatorStarsSource: source || 'aggregator',
    aggregatorStarsAt: new Date().toISOString(),
  };
}

/**
 * Patch for the rating in a walled page's own structured data. `show` is the
 * shows.json entry; the review must date from that production's run (same
 * rule as the Stage salvage) so a stale article filed under a revival stays
 * unscored. Returns the fields to set, or null.
 */
function pageStarPatch(data, html, { show, publishDate } = {}) {
  if (!data || !html || typeof html !== 'string') return null;
  if (!isMajorStarOutlet(data.outletId)) return null;
  if (isExcluded(data) || hasScorableBody(data) || hasAnyScore(data)) return null;
  const { isReviewWithinOwnProductionWindow } = require('./review-guards');
  const date = publishDate || data.publishDate;
  if (!show || !date || !isReviewWithinOwnProductionWindow(show, date)) return null;
  // The page must declare itself a review with a rating: a bare
  // "ratingValue" can be a product/aggregate rating elsewhere on the page.
  if (!/"reviewRating"|"@type"\s*:\s*"(?:Critic)?Review"/.test(html)) return null;
  // Text is deliberately empty: on a walled page the only trustworthy rating
  // is the structured one; glyph fallbacks read the visible (teaser) text.
  const found = extractScore(html, '', data.outletId, show.title);
  if (!found || !STRUCTURED_SOURCES.has(found.source)) return null;
  const normalized = typeof found.normalizedScore === 'number' ? found.normalizedScore : null;
  if (normalized == null) return null;
  return {
    originalScore: found.originalScore,
    originalScoreNormalized: normalized,
    originalScoreSource: found.source,
    scoreSource: found.source,
    scoreExtractedFrom: 'paywalled-page-structured-data',
  };
}

module.exports = {
  aggregatorStarsPatch,
  pageStarPatch,
  relayBlockReason,
  isMajorStarOutlet,
  MIN_SCORABLE_CHARS,
};
