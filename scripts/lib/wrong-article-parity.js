'use strict';
/**
 * BRO-3956: where do the hand-rolled `contentVerification.wrongArticle === true`
 * checks disagree with the canonical isRejectedNonReview() (review-guards.js)?
 *
 * Inline sites: gather-reviews.js "existingIsJunk" (any wrongArticle===true) and
 * merge-review-fields.js _isAdoptableSource (any wrongArticle===true). The canonical
 * predicate additionally needs confidence 'high' and honours the manual-clear hatches.
 */

const { isRejectedNonReview, cvWrongArticleManuallyCleared, wrongShowCleared } = require('./review-guards');

// null when the file has no wrongArticle verdict (nothing to compare).
function classifyWrongArticle(data) {
  const cv = data && data.contentVerification;
  if (!cv || cv.wrongArticle !== true) return null;
  if (isRejectedNonReview(data)) return { reason: 'agree' };
  if (cvWrongArticleManuallyCleared(data)) return { reason: 'manual-clear' };
  if (cv.confidence !== 'high') return { reason: `confidence-${cv.confidence || 'missing'}` };
  return { reason: 'other-carveout' };
}

// The wrongArticle half of isRejectedNonReview(), for call sites that ask only
// "is this file junk because of its CV verdict?": high confidence, and no human
// clear. A raw `wrongArticle === true` treats ~160 corpus files as junk that the
// canonical predicate keeps (medium/low confidence, human-cleared).
function wrongArticleVerdictStands(data) {
  const cv = data && data.contentVerification;
  return !!(cv && cv.wrongArticle === true && cv.confidence === 'high' &&
    !cvWrongArticleManuallyCleared(data) && !wrongShowCleared(data));
}

module.exports = { classifyWrongArticle, wrongArticleVerdictStands };
