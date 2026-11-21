'use strict';

// BRO-3875: measurement only. Missing a title is not evidence sufficient to
// stamp wrongShow: profiles, plot descriptions and related-work discussions
// can omit the filed title. See docs/audit/bro-3875-soft-type-wrongshow.md.
const { normalizeForMatch, isMentioned } = require('./essay-intro-nonreview-fp');
const { isAlreadyExcludedByOtherMechanism } = require('./nonreview-slug-coverage');
const { wrongShowCleared } = require('./review-guards');
const { laneBypasses } = require('./opening-night-lane/trust-model');

const SOFT_TYPES = new Set(['preview', 'interview', 'profile', 'feature', 'news', 'obituary']);

/**
 * Classify audit coverage, never a flagging verdict. The caller supplies the
 * canonical shows.json entry, rather than deriving metadata from a URL or ID.
 * null means outside BRO-3875's six-type population.
 */
function bucketSoftTypeWrongShow(data, show) {
  if (!data || data.isNonReview !== true || !SOFT_TYPES.has(data.nonReviewType)) return null;
  if (wrongShowCleared(data) || data.nonReviewManualClear === true || laneBypasses(data, 'nonReview')) {
    return 'protected';
  }
  if (typeof data.fullText !== 'string' || !data.fullText.trim()) return 'missing-text';
  if (isAlreadyExcludedByOtherMechanism(data)) return 'already-excluded';
  if (!show || typeof show.title !== 'string' || !show.title.trim()) return 'missing-show';
  return isMentioned(normalizeForMatch(data.fullText), show.title)
    ? 'target-mentioned'
    : 'wrong-show-suspect';
}

module.exports = { bucketSoftTypeWrongShow };
