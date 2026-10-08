'use strict';
/**
 * coverage-holes.js (BRO-4849) — the predicates behind the "found reviews that never reach the site" sweep.
 *
 * Affluenza (BRO-4838) showed 15 of 20 reviews: three were found but their text never arrived, one real review was
 * rejected as a preview, and a customer review was in the pile. A sweep of every show open or opened in the last 120
 * days found the same classes at scale. Each class here is a pure predicate over one review-text record, so the daily
 * audit (scripts/audit-coverage-holes.js) and the tests share ONE definition.
 *
 *   A noUsableText        found, includable, but no usable text and no rating: it can never score or show
 *   B rejectedYetVerified isNonReview / rejected as not_a_review while the content verification says it IS a review
 *                         (high confidence, not manually cleared). Mixed: some are correct (the stored URL is another
 *                         show's review), so `urlOtherShow` separates "repair the URL" from "clear the flag"
 *   C neverScored         includable and scoreable but with no score of any kind
 *   D blockedUrlUnflagged the URL is on a blocked host (aggregator, ticketing, social...) and nothing excludes it;
 *                         `kind` separates a relayed-star carrier (leave alone) from junk (exclude)
 *
 * Reuses the repo's own gates (isIncludableForRebuild, isScoreable, hasExcerpt, isBlockedReviewUrl) so the sweep can
 * never disagree with the rebuild about what counts.
 */
const { hasExcerpt } = require('./excerpt-fields');

// Fields that carry a usable rating even when there is no text.
const RATING_FIELDS = ['originalScore', 'originalScoreNormalized', 'aggregatorStars', 'starRating', 'originalRating', 'bwwThumb', 'dtliThumb', 'wetStars', 'westEndTheatreScore'];
// An explicit decision that already keeps a record off the site (or merges it away): a hole is what is left WITHOUT one.
const EXCLUSION_FLAGS = ['wrongProduction', 'wrongShow', 'isNonReview', 'isNotReview', 'nonReviewFlag', 'duplicateOf', 'isRoundupArticle', 'fabricatedEntry', 'isSyndicatedDuplicate', 'crossOutletDuplicate', 'rejectionReason', 'rejectedAt', 'listingPageUrl', 'suspectedMisattribution'];
const MIN_USABLE_TEXT = 200;
const NO_TEXT_REASONS = ['url_content_mismatch', 'scraper_garbage', 'scraper_timeout', 'not_attempted', 'no_url', 'bot_blocked'];

const has = (v) => v !== null && v !== undefined && v !== '' && v !== 0;
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const lazy = {
  includable: () => require('./review-guards').isIncludableForRebuild,
  scoreable: () => require('./is-scoreable').isScoreable,
  blocked: () => require('./domain-filters').isBlockedReviewUrl,
  aggregatorHost: () => require('./domain-filters').AGGREGATOR_DOMAINS,
};

const textLength = (d) => (typeof d.fullText === 'string' ? d.fullText.trim().length : 0);
const hasRating = (d) => RATING_FIELDS.some((f) => has(d[f]));
const isFlagged = (d) => EXCLUSION_FLAGS.some((f) => !!d[f]);
const hasAnyScore = (d) => num(d.assignedScore) || num(d.humanReviewScore) || num(d.adjudicatedScore) || (d.llmScore && num(d.llmScore.score));
const reasonOf = (d) => d.incompleteReason || null;

/** A: found but unusable and unrated. Returns the bucket ('url_content_mismatch' ... 'other') or null. */
function noUsableText(d) {
  if (!d || typeof d !== 'object') return null;
  if (textLength(d) >= MIN_USABLE_TEXT || hasExcerpt(d) || hasRating(d) || hasAnyScore(d)) return null;
  if (isFlagged(d)) return null; // an explicit exclusion is a decision, not a hole
  const r = reasonOf(d);
  return NO_TEXT_REASONS.includes(r) ? r : 'other';
}

/** The content verification's own verdict that this file is a genuine review. */
function cvSaysReview(d) {
  const cv = d && d.contentVerification;
  return !!cv && cv.articleType === 'review' && (cv.articleTypeConfidence || cv.confidence) === 'high';
}

/** B: rejected as a non-review although the verification says review. */
function rejectedYetVerified(d, show) {
  if (!d || typeof d !== 'object') return null;
  const rejected = d.isNonReview === true || d.rejectionReason === 'not_a_review';
  if (!rejected || d.nonReviewManualClear === true || !cvSaysReview(d)) return null;
  // A stale isNonReview flag the rebuild already ignores (a newer high-confidence review verdict beats an older
  // classifier verdict) reaches the site, so it is not a hole. rejectionReason has no such demotion yet: those stay.
  if (d.isNonReview === true && !d.rejectionReason && require('./review-guards').isNonReviewDemotedByFreshCV(d)) return null;
  // The verification itself can say the stored URL is another article (wrongArticle): then the rejection is right and
  // the URL is what needs repair. Otherwise a slug naming a different show says the same.
  let urlOtherShow = d.contentVerification.wrongArticle === true;
  if (!urlOtherShow && d.url && show && show.title) {
    try { urlOtherShow = require('./review-normalization').slugLooksLikeDifferentShow(d.url, { showTitle: show.title }) === true; } catch { /* unknown: not flagged */ }
  }
  return { urlOtherShow, how: d.isNonReview === true ? 'isNonReview' : 'rejectionReason' };
}

/** C: would be scored, has no score. `queued` = already needsRescore. */
function neverScored(d, show, filePath) {
  if (!d || typeof d !== 'object' || hasAnyScore(d) || has(d.originalScoreNormalized)) return null;
  if (!lazy.scoreable()(d, show, filePath)) return null;
  return { queued: d.needsRescore === true };
}

/** D: blocked-host URL with no exclusion. `kind`: 'relay-star' (aggregator URL holding a relayed rating) or 'junk'. */
function blockedUrlUnflagged(d) {
  if (!d || !d.url || !lazy.blocked()(d.url)) return null;
  if (isFlagged(d)) return null; // an exclusion flag already applies
  return { kind: has(d.aggregatorStars) || has(d.originalScore) || has(d.bwwThumb) || has(d.dtliThumb) ? 'relay-star' : 'junk' };
}

/** Which classes a record falls in, for the audit. */
function classify(d, show, filePath) {
  const out = {};
  const a = noUsableText(d, show, filePath); if (a) out.A = a;
  const b = rejectedYetVerified(d, show); if (b) out.B = b;
  const c = neverScored(d, show, filePath); if (c) out.C = c;
  const e = blockedUrlUnflagged(d, show, filePath); if (e) out.D = e;
  return out;
}

/** Shows open, or opened within `days` (default 120), the audit's scope. */
function isCurrentShow(show, now = Date.now(), days = 120) {
  if (!show || !show.id) return false;
  const st = String(show.status || '');
  if (st === 'open' || st === 'previews') return true;
  const od = Date.parse(show.openingDate || '');
  return Number.isFinite(od) && od <= now + 30 * 864e5 && now - od < days * 864e5 && st !== 'announced' && st !== 'upcoming' ? true : false;
}

module.exports = { EXCLUSION_FLAGS, RATING_FIELDS, MIN_USABLE_TEXT, NO_TEXT_REASONS, noUsableText, cvSaysReview, rejectedYetVerified, neverScored, blockedUrlUnflagged, classify, isCurrentShow };
