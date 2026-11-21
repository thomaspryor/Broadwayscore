'use strict';

/**
 * Pure helpers for scripts/backfill-london-theatre-stars.js (BRO-3139), kept in lib/ so the
 * tests can require() them (the CLI itself lives at the top level of scripts/).
 */
const { LONDON_THEATRE_PAGE_SOURCE } = require('./score-extractors');

const REVIEW_URL = /^https?:\/\/(?:www\.)?londontheatre\.co\.uk\/reviews\/[^?#]+/i;

function isCandidate(rec, file) {
  if (!rec || typeof rec !== 'object') return false;
  const outlet = String(rec.outletId || file.split('--')[0]);
  if (outlet !== 'london-theatre') return false;
  if (!REVIEW_URL.test(rec.url || '')) return false;
  if (rec.humanReviewScore) return false;
  // already excluded from scoring: the stars would change nothing, and each costs a fetch
  if (rec.wrongProduction || rec.wrongShow || rec.duplicateOf || rec.isNonReview) return false;
  if (rec.originalScoreSource === LONDON_THEATRE_PAGE_SOURCE) return false;
  return true;
}

/** Pure: the patched record for a found rating (also used by the tests). */
function applyRating(rec, rating) {
  const next = { ...rec };
  if (next.originalScore != null && next.originalScore !== rating.originalScore) next.previousOriginalScore = next.originalScore;
  next.originalScore = rating.originalScore;
  next.originalScoreNormalized = rating.normalizedScore;
  next.originalScoreSource = rating.source;
  delete next.originalScoreCleared;
  delete next.originalScoreClearedReason;
  delete next.scoreExtractionPending;
  // Same as the collect path (collect-review-texts.js: data.scoreSource = scoreResult.source). The
  // rebuild trusts a star only when scoreSource is a verified source (rebuild-helpers isOutletVerified),
  // and an aggregator scoreSource next to an outlet originalScore breaks validate-data's invariant.
  if (next.scoreSource && next.scoreSource !== rating.source) next.previousScoreSource = next.scoreSource;
  next.scoreSource = rating.source;
  return next;
}

module.exports = { isCandidate, applyRating, REVIEW_URL };
