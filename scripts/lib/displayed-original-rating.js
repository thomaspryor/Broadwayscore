'use strict';

const { detectBandFromReviewFile } = require('./star-reliability');

/**
 * The rating a reviews.json row carries as `originalRating`: the critic's own
 * published score, shown on the review card ("Rated 4/5 stars") when it drove
 * or anchored the score. Null when the rating played no part in the score, so
 * the card never advertises a number we did not use.
 *
 *  - originalScore-priority0 / -showscore-downgraded: the outlet's own rating IS the score.
 *  - aggregatorStars-relay / -fallback: the relayed star that drove the score (S6-T5).
 *  - anchored-v6: the LLM scored the prose inside the band of the critic's rating.
 *    detectBandFromReviewFile picks that rating by the same rules the scorer used,
 *    and only a high-reliability one anchors (the scorer stamps anchored-v6 on that
 *    condition alone), so the shown rating is the one that pinned the band.
 *
 * @param {string} source  scoreSource from getBestScore()
 * @param {object} data    the review-texts file
 * @returns {string|null}
 */
function displayedOriginalRating(source, data) {
  if (source === 'originalScore-priority0' || source === 'originalScore-showscore-downgraded') {
    return data.originalScore || null;
  }
  if (source === 'aggregatorStars-relay' || source === 'aggregatorStars-fallback') {
    return data.aggregatorStars || null;
  }
  if (source === 'anchored-v6') {
    const detected = detectBandFromReviewFile(data);
    return detected && detected.highReliability ? detected.starsRaw : null;
  }
  return null;
}

module.exports = { displayedOriginalRating };
