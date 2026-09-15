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

module.exports = { shouldLogRejection };
