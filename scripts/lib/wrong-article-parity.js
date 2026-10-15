'use strict';
/**
 * BRO-3956: where do the hand-rolled `contentVerification.wrongArticle === true`
 * checks disagree with the canonical isRejectedNonReview() (review-guards.js)?
 *
 * Inline sites: gather-reviews.js "existingIsJunk" (any wrongArticle===true) and
 * merge-review-fields.js _isAdoptableSource (any wrongArticle===true). The canonical
 * predicate additionally needs confidence 'high' and honours the manual-clear hatches.
 *
 * Audit result (BRO-3956, 2026-10-15, 56564 files): 2276 carry wrongArticle===true; 2113 agree with
 * the canonical predicate, 163 do not. Swapping gather-reviews to the canonical bar was tried and
 * rejected in review: the site sits in the cross-show URL decision, where even a medium-confidence
 * verdict (with cv.wrongProduction) is evidence the URL belongs to another show, and dropping it
 * makes ~90 files flip to a 'crossShow' rejection of the incoming review. Left as is on purpose.
 */

const { isRejectedNonReview, cvWrongArticleManuallyCleared } = require('./review-guards');

// null when the file has no wrongArticle verdict (nothing to compare).
function classifyWrongArticle(data) {
  const cv = data && data.contentVerification;
  if (!cv || cv.wrongArticle !== true) return null;
  if (isRejectedNonReview(data)) return { reason: 'agree' };
  if (cvWrongArticleManuallyCleared(data)) return { reason: 'manual-clear' };
  if (cv.confidence !== 'high') return { reason: `confidence-${cv.confidence || 'missing'}` };
  return { reason: 'other-carveout' };
}

module.exports = { classifyWrongArticle };
