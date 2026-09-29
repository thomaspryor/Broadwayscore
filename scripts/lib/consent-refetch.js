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
  // A flagged file whose QUARANTINED text is a consent capture: its flag was
  // set on that capture even if fullText has since been refilled with the
  // real article (Between the River and the Sea / WhatsOnStage).
  const q = typeof data.wrongFullText === 'string' ? data.wrongFullText : '';
  const flagged = data.wrongShow === true || data.isNonReview === true || data.wrongProduction === true;
  if (flagged && q && hasStrippableConsentLayer(q)) return true;
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
  if (!verdictClearsReview(cv)) return false;
  if (cv.articleType !== 'review') return false;
  if ((cv.articleTypeConfidence || cv.confidence) !== 'high') return false;
  const { hasStrippableConsentLayer } = require('./text-cleaning');
  const full = typeof data.fullText === 'string' ? data.fullText : '';
  if (full.length < 500 || hasStrippableConsentLayer(full)) return false;
  return true;
}

/**
 * The article a consent-prefixed capture already holds, with the consent layer
 * stripped, or null. Lets the drain re-verify stored text instead of
 * refetching an outlet that is currently unreachable (WhatsOnStage on
 * 2026-09-28: Playwright 'paywall', ScrapingBee 500, every review timing out
 * at 90s). Uses fullText, or the quarantined wrongFullText when fullText is
 * empty. Requires 1,500+ chars of non-garbage text after stripping.
 */
/** Hash of the stored text a salvage would verify (see consentSalvageVerifiedHash). */
function salvageSourceHash(data) {
  if (!data) return null;
  const full = typeof data.fullText === 'string' ? data.fullText : '';
  const q = typeof data.wrongFullText === 'string' ? data.wrongFullText : '';
  return require('crypto').createHash('md5').update(full + '\u0000' + q).digest('hex');
}

function salvageConsentPrefixedStoredText(data) {
  if (!data) return null;
  // Once per stored text: the stamp is the hash of the text that was verified,
  // written only after verification returned (ship-check: a pre-verify stamp
  // lost the salvage when a run was cancelled or the LLM call threw). Any
  // change to the stored text re-opens it.
  if (data.consentSalvageVerifiedHash && data.consentSalvageVerifiedHash === salvageSourceHash(data)) return null;
  const { stripConsentLayerPrefix, hasStrippableConsentLayer } = require('./text-cleaning');
  const { isGarbageContent } = require('./content-quality');
  const usable = (t) => t.length >= 1500 && !isGarbageContent(t).isGarbage && !hasStrippableConsentLayer(t);
  const full = typeof data.fullText === 'string' ? data.fullText : '';
  const q = typeof data.wrongFullText === 'string' ? data.wrongFullText : '';
  if (full && hasStrippableConsentLayer(full)) {
    const stripped = stripConsentLayerPrefix(full);
    return usable(stripped) ? stripped : null;
  }
  if (q && hasStrippableConsentLayer(q)) {
    // fullText refilled with a clean article since the flag: verify that.
    if (full && usable(full)) return full;
    const stripped = stripConsentLayerPrefix(q);
    return usable(stripped) ? stripped : null;
  }
  return null;
}

const VERIFIER_FLAG_PREFIXES = ['Collector LLM', 'CV-promoted'];

/**
 * Does a fresh verdict clear the review for release? Either a fully valid
 * verdict, or a high-confidence "this is a review" whose only doubt is a
 * LOW-confidence production question: the collector itself flags
 * wrongProduction only at high/medium confidence, and low-confidence doubts
 * come from the verifier's own temporal override (e.g. a review published a
 * day after opening that mentions the show's earlier Berlin/Edinburgh runs).
 */
function verdictClearsReview(cv) {
  if (!cv || cv.wrongArticle === true || cv.isFilmTv === true) return false;
  if (cv.isValid === true) return true;
  const articleIsReview = cv.articleType === 'review' && (cv.articleTypeConfidence || cv.confidence) === 'high';
  const productionDoubt = cv.wrongProduction === true && (cv.confidence === 'high' || cv.confidence === 'medium');
  return articleIsReview && !productionDoubt;
}
const isVerifierSetReason = (r) => typeof r === 'string' && VERIFIER_FLAG_PREFIXES.some(p => r.startsWith(p));

/**
 * Outcome of a retry (refetch or stored-text re-verify) on a flagged review,
 * applied to the post-verification record. Mutates `data`.
 *
 * Only verifier-set flags (Collector LLM / CV-promoted) are released: a
 * cross-show, human or scorer wrongShow is never cleared by one clean verdict
 * (ship-check P0). Clears carry the wrongShowAutoCleared / wrongProduction-
 * AutoCleared breadcrumbs the push-time restore honours
 * (review-write-guard.js CLEAR_BREADCRUMBS); a bare delete was put back at
 * push and the review refetched every run. wrongFullText is kept: its delete
 * is only honoured with the human wrongArticleManualClear hatch.
 */
function applyVerifiedRetryOutcome(data, nowIso) {
  const out = { clearedWrongShow: false, clearedWrongProduction: false };
  if (!data) return out;
  const cv = data.contentVerification;
  const clean = verdictClearsReview(cv);
  if (!clean) {
    data.wrongShowRetryAt = nowIso;
    return out;
  }
  if (data.wrongShow === true && isVerifierSetReason(data.wrongShowReason)) {
    delete data.wrongShow;
    delete data.wrongShowReason;
    delete data.wrongShowNote;
    data.wrongShowAutoCleared = 'collect-review-texts: retry of this URL passed content verification';
    data.wrongShowAutoClearedAt = nowIso;
    out.clearedWrongShow = true;
  }
  if (data.wrongProduction === true && isVerifierSetReason(data.wrongProductionReason)
      && cv.wrongProduction !== true && cv.confidence === 'high') {
    delete data.wrongProduction;
    delete data.wrongProductionNote;
    data.wrongProductionAutoCleared = 'collect-review-texts: retry of this URL passed content verification (high confidence, right production)';
    data.wrongProductionAutoClearedAt = nowIso;
    out.clearedWrongProduction = true;
  }
  if (data.wrongShow !== true) delete data.wrongShowRetryAt;
  return out;
}

module.exports = {
  verdictClearsReview,
  applyVerifiedRetryOutcome,
  salvageSourceHash,
  salvageConsentPrefixedStoredText,
  shouldRetryGarbageConsentWall,
  storedTextNeedsConsentRefetch,
  shouldReleaseConsentLayerNonReview,
  REFETCH_COOLDOWN_MS,
};
