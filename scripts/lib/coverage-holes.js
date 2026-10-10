'use strict';
/**
 * coverage-holes.js (BRO-4849) — the predicates behind the "found reviews that never reach the site" sweep.
 *
 * Affluenza (BRO-4838) showed 15 of 20 reviews: three were found but their text never arrived, one real review was
 * rejected as a preview, and a customer review was in the pile. A sweep of every show open or opened in the last 120
 * days found the same classes at scale. Each class is a pure predicate over one review-text record, so the audit
 * (scripts/audit-coverage-holes.js) and the tests share ONE definition.
 *
 * Built ON explainExclusion / hasValidScore / isScoreable (scripts/lib/review-guards.js), never beside them: the
 * rebuild's own rule chain decides what counts as excluded or scored, so the sweep cannot disagree with it. (An earlier
 * draft re-derived those rules by hand and over-counted C by 34 and A by 20.) Siblings: scripts/exclusion-rule-census.js
 * (every excluded file by rule) and scripts/audit-nonreview-cv-conflict.js (the isNonReview-vs-verification shape).
 *
 *   A noUsableText        the rebuild drops it for having neither text nor a score signal (noTextOrScoreSignal,
 *                         wrongContentNoUsableSignal): found, but it can never show. Bucketed by incompleteReason
 *   B rejectedYetVerified isNonReview / rejected as not_a_review while the content verification says it IS a review
 *                         (high confidence, not manually cleared) and the rebuild still excludes it. `blockedBy` is the
 *                         rule that actually keeps it off (clearing the non-review flag alone does not publish a file
 *                         that is also wrongProduction or duplicateOf); `urlOtherShow` separates "repair the URL" from
 *                         "read the text"
 *   C neverScored         includable and scoreable, with no valid score by the rebuild's own definition
 *   D blockedUrlUnflagged the URL is on a blocked host (aggregator, ticketing, social...) and carries no exclusion flag.
 *                         The rebuild drops these at runtime (blockedReviewUrl), so the HARM is only when one is
 *                         published (the audit joins reviews.json); the rest is hygiene. `kind` separates a
 *                         relayed-rating carrier (leave alone) from junk (exclude)
 */
const { hasExcerpt } = require('./excerpt-fields');

// An explicit decision stored on the record: D's "no exclusion flag" test.
const EXCLUSION_FLAGS = ['wrongProduction', 'wrongShow', 'isNonReview', 'isNotReview', 'nonReviewFlag', 'duplicateOf', 'isRoundupArticle', 'fabricatedEntry', 'isSyndicatedDuplicate', 'crossOutletDuplicate', 'rejectionReason', 'rejectedAt', 'suspectedMisattribution'];
const NO_TEXT_REASONS = ['url_content_mismatch', 'scraper_garbage', 'scraper_timeout', 'not_attempted', 'no_url', 'bot_blocked'];
const NO_SIGNAL_RULES = ['noTextOrScoreSignal', 'wrongContentNoUsableSignal'];

const has = (v) => v !== null && v !== undefined && v !== '' && v !== 0;
const guards = () => require('./review-guards');
const isFlagged = (d) => EXCLUSION_FLAGS.some((f) => !!d[f]);

/** A: the rebuild drops it for lack of text and score signal. Returns the incompleteReason bucket or null. */
function noUsableText(d, show, filePath) {
  if (!d || typeof d !== 'object') return null;
  if (!NO_SIGNAL_RULES.includes(guards().explainExclusion(d, show, filePath))) return null;
  return NO_TEXT_REASONS.includes(d.incompleteReason) ? d.incompleteReason : 'other';
}

/** The content verification's own verdict that this file is a genuine review. */
function cvSaysReview(d) {
  const cv = d && d.contentVerification;
  return !!cv && cv.articleType === 'review' && (cv.articleTypeConfidence || cv.confidence) === 'high';
}

/** B: rejected as a non-review although the verification says review, and still kept off the site. */
function rejectedYetVerified(d, show, filePath) {
  if (!d || typeof d !== 'object') return null;
  const rejected = d.isNonReview === true || d.rejectionReason === 'not_a_review';
  if (!rejected || d.nonReviewManualClear === true || !cvSaysReview(d)) return null;
  // A stale isNonReview flag the rebuild already ignores (a newer high-confidence review verdict beats an older
  // classifier verdict) reaches the site, so it is not a hole. rejectionReason has no such demotion yet: those stay.
  if (d.isNonReview === true && !d.rejectionReason && guards().isNonReviewDemotedByFreshCV(d)) return null;
  const blockedBy = guards().explainExclusion(d, show, filePath);
  if (!blockedBy) return null; // the rebuild includes it: it is on the site
  // The verification itself can say the stored URL is another article (wrongArticle): then the rejection is right and
  // the URL is what needs repair. Otherwise a slug naming a different show says the same.
  let urlOtherShow = d.contentVerification.wrongArticle === true;
  if (!urlOtherShow && d.url && show && show.title) {
    try { urlOtherShow = require('./review-normalization').slugLooksLikeDifferentShow(d.url, { showTitle: show.title }) === true; } catch { /* unknown: not flagged */ }
  }
  return { urlOtherShow, how: d.isNonReview === true ? 'isNonReview' : 'rejectionReason', blockedBy };
}

/** C: would be scored, has no valid score by the rebuild's own definition. `queued` = already needsRescore. */
function neverScored(d, show, filePath) {
  if (!d || typeof d !== 'object') return null;
  if (!require('./is-scoreable').isScoreable(d, show, filePath) || guards().hasValidScore(d)) return null;
  return { queued: d.needsRescore === true };
}

/** D: blocked-host URL with no exclusion flag. `kind`: 'relay-star' (carries a relayed rating) or 'junk'. */
function blockedUrlUnflagged(d) {
  if (!d || !d.url || !require('./domain-filters').isBlockedReviewUrl(d.url) || isFlagged(d)) return null;
  return { kind: has(d.aggregatorStars) || has(d.originalScore) || has(d.bwwThumb) || has(d.dtliThumb) ? 'relay-star' : 'junk' };
}

/** Which classes a record falls in, for the audit. */
function classify(d, show, filePath) {
  const out = {};
  const a = noUsableText(d, show, filePath); if (a) out.A = { bucket: a };
  const b = rejectedYetVerified(d, show, filePath); if (b) out.B = b;
  const c = neverScored(d, show, filePath); if (c) out.C = c;
  const e = blockedUrlUnflagged(d); if (e) out.D = e;
  return out;
}

/** Shows open, or opened within `days` (default 120) and not still announced: the audit's scope. */
function isCurrentShow(show, now = Date.now(), days = 120) {
  if (!show || !show.id) return false;
  const status = String(show.status || '');
  if (status === 'open' || status === 'previews') return true;
  if (status === 'announced' || status === 'upcoming') return false;
  const opened = Date.parse(show.openingDate || '');
  return Number.isFinite(opened) && opened <= now + 30 * 864e5 && now - opened < days * 864e5;
}

module.exports = { EXCLUSION_FLAGS, NO_TEXT_REASONS, NO_SIGNAL_RULES, hasExcerpt, noUsableText, cvSaysReview, rejectedYetVerified, neverScored, blockedUrlUnflagged, classify, isCurrentShow };
