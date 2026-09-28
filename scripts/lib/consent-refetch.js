'use strict';

/**
 * consent-refetch.js — decide whether a wrongShow/wrongProduction review whose
 * STORED text is garbage should be re-fetched so the consent-backlog auto-drains.
 *
 * Background (2026-06-28): the cookie-consent dismissal added to the scraper
 * (cookie-consent.js, 2026-06) can now read consent-walled outlets
 * (whatsonstage the repeat offender). But 424 reviews corpus-wide were captured
 * BEFORE that fix landed and stored EMPTY / consent-wall text, then got flagged
 * wrongShow / wrongProduction. The wrong-content skip in collect-review-texts.js
 * blocks flagged files from retrying (14-day cooldown only for `Collector LLM`
 * flags), so these never re-fetch and the real review stays missing forever.
 *
 * This decision lets a flagged review retry IFF its stored text is already
 * garbage (empty capture / pure consent-wall — isGarbageContent.isGarbage). That
 * is the safe signal: a flag set on garbage text has no real review to protect,
 * so re-fetching can only help. A flag on a review with REAL buried text
 * (isGarbage=false, e.g. a Time Out newsletter prefix + the actual review) is
 * NOT matched — re-fetching as garbage there would risk nulling a live review.
 *
 * A cooldown gates retries so an outlet whose wall still can't be dismissed
 * isn't re-scraped every run — drain once, then re-try every 14 days.
 *
 * Pure function (no I/O) so it can be unit-tested per project rule 15. The
 * caller computes isGarbageContent(text).isGarbage and passes it in.
 */

const REFETCH_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * @param {object} ctx
 * @param {boolean} ctx.hasGarbageStoredText - isGarbageContent(data.fullText).isGarbage
 * @param {number|null} ctx.lastRetryMs - epoch ms of the last retry attempt (the
 *   existing data.wrongShowRetryAt, stamped by the post-fetch handler), or null
 * @param {number} ctx.nowMs - current epoch ms
 * @returns {boolean}
 */
function shouldRetryGarbageConsentWall({ hasGarbageStoredText, lastRetryMs, nowMs } = {}) {
  if (!hasGarbageStoredText) return false;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return false;
  const age = (typeof lastRetryMs === 'number' && Number.isFinite(lastRetryMs))
    ? nowMs - lastRetryMs
    : Infinity;
  return age > REFETCH_COOLDOWN_MS;
}

/**
 * True when a review's stored text is a consent-wall capture worth re-fetching:
 * garbage outright, or text that OPENS with a strippable IAB consent layer
 * (BRO-4185 A: WhatsOnStage captures put ~6,500 chars of consent notices ahead
 * of the article, the verifier read only those and flagged the review). When
 * fullText was quarantined into wrongFullText, that text is checked instead.
 */
function storedTextNeedsConsentRefetch(data) {
  if (!data) return false;
  const { isGarbageContent } = require('./content-quality');
  const { hasStrippableConsentLayer } = require('./text-cleaning');
  const full = typeof data.fullText === 'string' ? data.fullText : '';
  if (full) return isGarbageContent(full).isGarbage || hasStrippableConsentLayer(full);
  const quarantined = typeof data.wrongFullText === 'string' ? data.wrongFullText : '';
  if (!quarantined) return false;
  return isGarbageContent(quarantined).isGarbage || hasStrippableConsentLayer(quarantined);
}

const CV_PROMOTED_NON_REVIEW_PREFIXES = ['CV-promoted (not a review):', 'Collector LLM'];

/**
 * After a consent-layer refetch: release an isNonReview flag that the content
 * verifier set on the consent text, once a fresh verdict on the stripped
 * article says it is a review at high confidence. Only the verifier-promoted
 * family is eligible; classifier-set and manual flags are left alone.
 */
function shouldReleaseConsentLayerNonReview(data) {
  if (!data || data.isNonReview !== true) return false;
  const reason = typeof data.isNonReviewReason === 'string' ? data.isNonReviewReason : '';
  if (!CV_PROMOTED_NON_REVIEW_PREFIXES.some(p => reason.startsWith(p))) return false;
  const cv = data.contentVerification;
  if (!cv || cv.isValid !== true) return false;
  if (cv.wrongArticle === true || cv.wrongProduction === true || cv.isFilmTv === true) return false;
  if (cv.articleType !== 'review') return false;
  if ((cv.articleTypeConfidence || cv.confidence) !== 'high') return false;
  const { hasStrippableConsentLayer } = require('./text-cleaning');
  const full = typeof data.fullText === 'string' ? data.fullText : '';
  if (full.length < 500 || hasStrippableConsentLayer(full)) return false;
  return true;
}

module.exports = {
  shouldRetryGarbageConsentWall,
  storedTextNeedsConsentRefetch,
  shouldReleaseConsentLayerNonReview,
  REFETCH_COOLDOWN_MS,
};
