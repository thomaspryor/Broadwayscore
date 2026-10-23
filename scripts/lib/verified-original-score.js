'use strict';
/**
 * verified-original-score (BRO-4849): set or clear a critic's stored rating after a human checked it against the
 * outlet's own page. One owner for the whole rating field set, so an approved-fix plan (review-field-edit.js) cannot
 * leave a half-written rating the rebuild ignores or the collector overwrites.
 *
 * The rating lives in several fields, and each one is read somewhere (second-opinion review, BRO-4849):
 *   originalScore / originalScoreNormalized / originalScoreSource / originalScoreType  the rating itself
 *   starRating / originalRating   read BEFORE originalScore by the star band (star-reliability.js) and the F audit
 *   scoreSource / scoreConfidence a low-reliability or aggregator scoreSource makes getBestScore skip or demote the
 *                                 rating, and an unverified one lets the collector's RESCORE-FULLTEXT pass re-extract it
 *   originalScoreCleared          sticky: while true the rebuild skips the rating (rebuild-helpers.js P0.5)
 * Sibling of no-rating-outlet-score.js (the clear path matches its field writes).
 */
const VERIFIED_SOURCE = 'manual-verified';

/** Why `raw` cannot be stored as a verified rating for `data`, or null. */
function verifiedRatingError(data, raw) {
  if (raw === null) return null;
  if (typeof raw !== 'string' || !raw.trim()) return 'originalScore must be a rating string or null';
  if (!data || !data.outletId) return 'originalScore: record has no outletId (letter grades would parse for any outlet)';
  if (!require('./rebuild-helpers').isUnambiguousRatingString(raw)) return `originalScore: "${raw}" is not an unambiguous rating (use "3/5", "B+", "4 stars")`;
  const n = require('./score-parsers').parseOriginalScore(raw, data.outletId);
  if (typeof n !== 'number' || !Number.isFinite(n)) return `originalScore: "${raw}" does not parse for outlet ${data.outletId}`;
  return null;
}

/**
 * Mutates `data`. `raw` null clears the rating; a string sets it. Returns { ok, reason? }.
 * The wrong value is kept as originalScoreCorrectedFrom, not previousOriginalScore: star-reliability counts
 * previousOriginalScore as a star an adjudication may have relied on.
 */
function applyVerifiedOriginalScore(data, raw, reason) {
  const err = verifiedRatingError(data, raw);
  if (err) return { ok: false, reason: err };
  const why = reason || 'rating verified against the outlet page';
  const prior = data.originalScore == null ? null : data.originalScore;
  if (raw === null) {
    data.originalScore = null;
    data.originalScoreNormalized = null;
    data.originalScoreSource = null;
    data.originalScoreType = null;
    data.originalScoreCleared = true;
    data.originalScoreClearedReason = why;
  } else {
    data.originalScore = raw;
    data.originalScoreNormalized = require('./score-parsers').parseOriginalScore(raw, data.outletId);
    data.originalScoreSource = VERIFIED_SOURCE;
    data.originalScoreType = null;
    // Explicit false, not delete: a deleted protected field is restored on write.
    if (data.originalScoreCleared === true) data.originalScoreCleared = false;
    // Rewritten, not nulled: the reason is a protected field the write guard would restore.
    if (data.originalScoreClearedReason != null) data.originalScoreClearedReason = `un-cleared (${why}); was: ${data.originalScoreClearedReason}`;
    // A verified rating is the score's source too: high reliability for getBestScore, and in OUTLET_VERIFIED_SOURCES
    // so the collector does not re-extract over it.
    data.scoreSource = VERIFIED_SOURCE;
    if (data.scoreConfidence === 'low') data.scoreConfidence = null;
  }
  // A stored star that disagrees would keep binding the band.
  for (const k of ['starRating', 'originalRating']) if (data[k] != null) data[k] = null;
  data.originalScoreCorrectedFrom = prior;
  // A verdict judged the models against the old star. Once that star is changed or
  // cleared (a person's correction, a refetch, a multi-show split) the verdict is
  // void whichever side it took: Exit the King's "sided with LLM" note still rested
  // on a wrong 4/5 and kept publishing 80 over a 3/5 (BRO-5942). Compared as parsed
  // ratings so '3/5' and '3/5 stars' are the same star; a first star voids nothing.
  const parse = (v) => (v == null ? null : require('./score-parsers').parseOriginalScore(v, data.outletId));
  const changed = prior != null && (raw == null || (parse(prior) ?? String(prior)) !== (parse(raw) ?? String(raw)));
  require('./star-reliability').invalidateStarSidedAdjudication(data, why, { anySide: changed });
  return { ok: true };
}

/**
 * True when a human verified the stored rating against the outlet page. Automated extraction must not replace it:
 * scoreSource alone is not enough, because the scorer re-stamps it (e.g. 'anchored-v6') after the fix lands.
 */
function isHumanVerifiedRating(data) {
  return !!data && data.originalScoreSource === VERIFIED_SOURCE && data.originalScore != null;
}

module.exports = { VERIFIED_SOURCE, verifiedRatingError, applyVerifiedOriginalScore, isHumanVerifiedRating };
