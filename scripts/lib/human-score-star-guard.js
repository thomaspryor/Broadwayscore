'use strict';

/**
 * human-score-star-guard.js — a published star/grade rating is a band the score
 * must land in (anchored-v6, scripts/llm-scoring/config.ts starToBand), so a
 * manual humanReviewScore (rebuild priority P0b, above everything) must not
 * move a starred review outside its critic's own rating.
 *
 * Found 2026-10-05 on slam-frank-off-broadway-2026: a hand-set override of 58
 * (then 66) was applied to a 2/5-star Culture Sauce review whose anchored
 * score (39, band 31-50) was correct. The override was based on a partial read
 * of the article and ignored the star rating entirely.
 *
 * Reuses detectBandFromReviewFile so the band rules stay in one place.
 *
 * @param {object} data   review-text JSON contents
 * @param {number} score  proposed humanReviewScore (0-100)
 * @returns {{starsRaw: string, floor: number, ceiling: number}|null}
 *          null when the score is allowed (no star/grade band, or inside it)
 */
function humanScoreOutsideStarBand(data, score) {
  const { detectBandFromReviewFile } = require('./star-reliability');
  const detected = detectBandFromReviewFile(data);
  if (!detected || !detected.band) return null;
  // Only a reliable rating binds the score. A junk generic-pattern star or a
  // relayed aggregator value (Mincemeat's wrong 1/5, BRO-4499) must not block a
  // correct manual override.
  if (!detected.highReliability) return null;
  const { floor, ceiling } = detected.band;
  if (!Number.isFinite(floor) || !Number.isFinite(ceiling)) return null;
  if (score >= floor && score <= ceiling) return null;
  return { starsRaw: detected.starsRaw, floor, ceiling };
}

module.exports = { humanScoreOutsideStarBand };
