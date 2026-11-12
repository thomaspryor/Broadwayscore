'use strict';
/**
 * adjudication-star-conflict (BRO-4318): an auto-adjudication that "sided with LLM" against the critic's stored
 * rating, landing outside that rating's band. Either the stored rating is a mis-extraction (fix: correct or clear
 * originalScore through an approved fix, which also voids the adjudication) or the rating is right and the
 * adjudication is wrong (fix: clear adjudicatedScore, so the star stands). Both fixes are review-field-edit actions.
 *
 * The band comes from star-reliability.detectBandFromReviewFile (the same one the scorer anchors to), whatever its
 * reliability: a low-reliability star still disagrees with the adjudication, and that disagreement is what a human
 * resolves. Tolerance matches the published-score band check (published-score-star-band.js, +/-2).
 */
const { detectBandFromReviewFile } = require('./star-reliability');

const TOL = 2;
const SIDED_WITH_LLM = /sided with llm\)/i;

/** The conflict on `data`, or null when there is none. */
function adjudicationStarConflict(data) {
  if (!data || typeof data.adjudicatedScore !== 'number' || !Number.isFinite(data.adjudicatedScore)) return null;
  if (!SIDED_WITH_LLM.test(data.adjudicationNote || '')) return null;
  if (data.originalScore == null || data.originalScore === '') return null;
  const det = detectBandFromReviewFile(data);
  if (!det || !det.band || typeof det.band.floor !== 'number') return null;
  const { floor, ceiling } = det.band;
  const s = data.adjudicatedScore;
  if (s >= floor - TOL && s <= ceiling + TOL) return null;
  return { adjudicatedScore: s, rating: det.starsRaw, floor, ceiling };
}

const DISPOSITIONS = ['star-corrected', 'star-cleared', 'adjudication-cleared'];

/**
 * Whether a record is in the resolved state its disposition promises.
 *   star-corrected       the rating was wrong; a verified rating replaced it (originalScoreCorrectedFrom kept)
 *   star-cleared         the outlet prints no rating for this review; the stored one is cleared
 *   adjudication-cleared the rating is right; the adjudication is dropped (adjudicatedScoreInvalidated kept)
 * Every resolved record carries no live conflicting adjudication.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function dispositionResolved(data, disposition, expectedRating) {
  if (!data) return { ok: false, reason: 'record missing' };
  if (!DISPOSITIONS.includes(disposition)) return { ok: false, reason: `unknown disposition ${disposition}` };
  const conflict = adjudicationStarConflict(data);
  if (conflict) return { ok: false, reason: `adjudication ${conflict.adjudicatedScore} still outside ${conflict.rating} band ${conflict.floor}-${conflict.ceiling}` };
  if (disposition === 'star-corrected') {
    if (data.originalScoreSource !== 'manual-verified' || data.originalScoreCorrectedFrom == null) return { ok: false, reason: 'rating not corrected by a verified fix' };
    if (expectedRating != null && String(data.originalScore) !== String(expectedRating)) return { ok: false, reason: `rating is ${data.originalScore}, expected ${expectedRating}` };
  }
  if (disposition === 'star-cleared') {
    if (data.originalScore != null || data.originalScoreCleared !== true) return { ok: false, reason: `rating ${data.originalScore} not cleared` };
  }
  if (disposition === 'adjudication-cleared') {
    if (data.originalScore == null) return { ok: false, reason: 'the rating that should stand is gone' };
    if (expectedRating != null && String(data.originalScore) !== String(expectedRating)) return { ok: false, reason: `rating is ${data.originalScore}, expected ${expectedRating}` };
    if (data.adjudicatedScore != null) return { ok: false, reason: `adjudicatedScore ${data.adjudicatedScore} still set` };
  }
  return { ok: true };
}

module.exports = { adjudicationStarConflict, dispositionResolved, DISPOSITIONS, TOL };
