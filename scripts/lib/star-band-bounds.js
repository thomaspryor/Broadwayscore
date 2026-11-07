'use strict';
/**
 * BRO-6725: score band a /5 star rating allows (1/5 0-30, 2/5 31-50, 3/5 51-70, 4/5 71-90, 5/5 91-100).
 * A half star spans two bands (3.5/5 -> 51-90). Parsed with star-parse so "3.5/5" is not read as
 * "5/5" (the check's old regex took the trailing digit and flagged a correct 3.5/5 -> 70 as 5/5 -> 70).
 * Returns null for ratings that are not out of 5 or are unparseable.
 */
const { parseStar } = require('./star-parse');
const BANDS = { 1: [0, 30], 2: [31, 50], 3: [51, 70], 4: [71, 90], 5: [91, 100] };

function starBandBounds(rating) {
  const p = parseStar(rating);
  if (!p || p.outOf !== 5 || p.stars == null || p.stars < 0.5) return null;
  const lo = BANDS[Math.max(1, Math.floor(p.stars))];
  const hi = BANDS[Math.min(5, Math.ceil(p.stars))];
  return lo && hi ? [lo[0], hi[1]] : null;
}
const scoreOutsideStarBand = (rating, score) => {
  const b = starBandBounds(rating);
  return !!b && score != null && (score < b[0] || score > b[1]);
};
module.exports = { starBandBounds, scoreOutsideStarBand };
