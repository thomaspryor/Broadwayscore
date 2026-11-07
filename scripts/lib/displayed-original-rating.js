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
 *    The rating is shown only when the band it implies equals the band stored on
 *    the file when it was scored (llmScore.band). That is the proof it is the
 *    rating that pinned the score: a rating extracted or corrected after anchoring
 *    (the Equus/Telegraph case, rebuild-helpers.js) has a different band, and a
 *    file with no stored band shows nothing. highReliability is not a check here:
 *    on an anchored-v6 file it keys off scoreSource, which is 'anchored-v6' itself.
 *
 * @param {string} source  scoreSource from getBestScore()
 * @param {object} data    the review-texts file
 * @returns {string|number|null}  the stored rating (older rows hold a bare number)
 */
function displayedOriginalRating(source, data) {
  if (source === 'originalScore-priority0' || source === 'originalScore-showscore-downgraded') {
    return data.originalScore || null;
  }
  if (source === 'aggregatorStars-relay' || source === 'aggregatorStars-fallback') {
    return data.aggregatorStars || null;
  }
  if (source === 'anchored-v6') {
    const stored = data.llmScore && data.llmScore.band;
    const detected = detectBandFromReviewFile(data);
    if (!stored || !detected || !detected.band) return null;
    return stored.floor === detected.band.floor && stored.ceiling === detected.band.ceiling
      ? detected.starsRaw
      : null;
  }
  return null;
}

module.exports = { displayedOriginalRating };
