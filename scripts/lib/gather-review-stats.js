/**
 * gather-review-stats.js — BRO-931 #1 (silent failure default).
 *
 * createReviewFile() in gather-reviews.js returns a string reason code on
 * every skip path (blocklisted, domainMismatch, crossMarketContamination,
 * ...). Before this fix, gather-reviews.js only counted a result if it was a
 * key in a hardcoded `health.rejections` enum — any skip reason added to
 * createReviewFile without also being added to that enum (blocklisted,
 * staleFlagCollision, profileUrl, crossMarketContamination all shipped this
 * way) was silently dropped: not counted, not logged, invisible in the run
 * summary. During the Fear of 13 (2026-04-15) opening night, this class of
 * gap was part of why "local 21 vs live 13" went unexplained for hours.
 *
 * shouldLogRejection() replaces the enum-membership check: ANY string result
 * is a real exclusion and must be logged, regardless of whether it happens
 * to be a key someone remembered to add to health.rejections. This makes
 * "forgot to register a new skip reason" structurally impossible to repeat.
 */

'use strict';

function shouldLogRejection(result) {
  return typeof result === 'string' && result.length > 0;
}

/**
 * BRO-931 #3 follow-up (adversarial ship-check finding) — should this review
 * be stamped isPreviewPlaceholder (a flag review-guards.js's
 * explainExclusion() now excludes from rebuild, see BRO-931 #3)?
 *
 * A wrong stamp is now actively harmful, not just cosmetic: a legitimate
 * post-opening review would silently vanish from reviews.json. shows.json's
 * status field lags reality (update-show-status.yml runs once daily), so a
 * show can sit at status:'previews' for hours after it has genuinely opened.
 * Two self-heals against that staleness:
 *   1. options.fromPostOpening === true is an explicit caller assertion —
 *      the opening-night poller always passes it, and its own dispatch
 *      filter already restricts targets to open/effectively-open shows, so
 *      it's trusted over a possibly-stale status field.
 *   2. Even without that signal, a status still reading 'previews' must not
 *      override an openingDate that has already passed — mirrors
 *      gather-reviews.js's own "Auto-detect post-opening context" block,
 *      which already treats openingDate <= now as an override for exactly
 *      this same staleness.
 *
 * @param {object|null} showMeta - the show's shows.json record (or null/undefined)
 * @param {object} [options] - createReviewFile's options; only fromPostOpening is read
 * @returns {boolean}
 */
function shouldStampPreviewPlaceholder(showMeta, options = {}) {
  if (!showMeta || options.fromPostOpening) return false;
  const hasOpenedByDate = !!(showMeta.openingDate && new Date(showMeta.openingDate) <= new Date());
  const isPreviewsStatus = showMeta.status === 'previews' && !hasOpenedByDate;
  const hasNotOpenedYet = !!(showMeta.openingDate && new Date(showMeta.openingDate) > new Date());
  return isPreviewsStatus || hasNotOpenedYet;
}

module.exports = { shouldLogRejection, shouldStampPreviewPlaceholder };
