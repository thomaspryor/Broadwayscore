'use strict';

/**
 * star-band-regression.js (BRO-4770) — pure predicates behind the standing
 * detector scripts/detect-star-band-regressions.js and the corpus inventory
 * scripts/audit-star-band-drift.js. No star logic of its own: it composes the
 * canonical predicates (needsLateStarReanchor, humanScoreOutsideStarBand,
 * scoringStamp) so the detector can never disagree with the scorer.
 *
 *   starBandVerdict(d, ctx)       a high-reliability star/grade whose review is
 *                                 not anchored, or whose score sits outside its
 *                                 band by more than `tol`
 *   scoringRegression(prev, next) a later whole-file write reverted a newer
 *                                 scoring group (the clobber signature)
 */

const { needsLateStarReanchor } = require('./late-star-anchor');
const { humanScoreOutsideStarBand } = require('./human-score-star-guard');
const { scoringStamp } = require('./scoring-recency');

const DEFAULT_TOL = 2;

/**
 * @param {object} d      review-text record
 * @param {object} ctx    { category, show, filePath } as for needsLateStarReanchor
 * @param {number} [tol]  points outside the band tolerated for an anchored score
 * @returns {{kind: 'unanchored'|'out-of-band', starsRaw: string, floor: number, ceiling: number, score?: number}|null}
 */
function starBandVerdict(d, ctx = {}, tol = DEFAULT_TOL) {
  if (!d || d.needsRescore === true) return null; // already queued for the drain
  const late = needsLateStarReanchor(d, ctx);
  if (late) {
    return { kind: 'unanchored', starsRaw: late.starsRaw, floor: late.band.floor, ceiling: late.band.ceiling };
  }
  // A hand override or adjudication is the final word (rebuild P0b/P0a); the
  // rebuild-time warning covers those, a rescore cannot change them.
  if (d.humanReviewScore != null || d.adjudicatedScore != null) return null;
  // One automatic re-score per file: if the drain already ran for this flag and
  // the score is STILL out of band, re-flagging every 6h would loop the spend.
  if (d.starBandFlaggedAt) return null;
  // Only an ANCHORED score (llmScore.band present) can be wrong in a way a
  // re-score fixes. A legacy un-banded llmScore is not what the rebuild
  // publishes for a star outlet (the star routes the score), so re-scoring it
  // would spend with no live change.
  if (!d.llmScore || !d.llmScore.band) return null;
  const s = d.llmScore.score;
  if (typeof s !== 'number') return null;
  const v = humanScoreOutsideStarBand(d, s);
  if (v && (s < v.floor - tol || s > v.ceiling + tol)) {
    return { kind: 'out-of-band', starsRaw: v.starsRaw, floor: v.floor, ceiling: v.ceiling, score: s };
  }
  return null;
}

/**
 * Clobber signature: `next` (the later write) carries an OLDER scoring stamp
 * than `prev` while the star data is unchanged. A deliberate clear (null
 * llmScore/llmMetadata) and a changed star are not clobbers.
 *
 * @returns {{kind: 'clobbered', from: number, to: number, lostBand: boolean}|null}
 */
function scoringRegression(prev, next) {
  if (!prev || !next) return null;
  if (next.llmScore == null || next.llmMetadata == null) return null;
  if (prev.originalScoreNormalized !== next.originalScoreNormalized) return null;
  const from = scoringStamp(prev);
  const to = scoringStamp(next);
  if (!(from > 0) || !(to < from)) return null;
  const lostBand = !!(prev.llmScore && prev.llmScore.band) && !(next.llmScore && next.llmScore.band);
  return { kind: 'clobbered', from, to, lostBand };
}

module.exports = { starBandVerdict, scoringRegression, DEFAULT_TOL };
