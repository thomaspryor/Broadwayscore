/**
 * Discard an originalScore that sits on an outlet adjudicated to publish no
 * critic rating (NO_CRITIC_RATING_OUTLETS, e.g. london-theatre). Any value there
 * is a relayed Show-Score audience aggregate, not the critic's verdict.
 *
 * Why this exists (BRO-2809): the collect step re-extracts SS-sourced scores,
 * but extractors correctly return null for these outlets, so the Show-Score
 * placeholder survived untouched (and later got an llm-v6 scoreSource that made
 * it look verified). Discarded, NOT moved to aggregatorStars: an audience
 * average parked there would feed the aggregatorStars fallback in getBestScore().
 *
 * Mutates `data`. Returns true if a score was discarded.
 */
const { publishesNoCriticRating } = require('./score-extractors');
const { invalidateStarSidedAdjudication } = require('./star-reliability');

function discardNoRatingOutletScore(data) {
  if (!data || data.originalScore == null || data.originalScore === '') return false;
  if (!publishesNoCriticRating(data.outletId, data)) return false;
  data.previousOriginalScore = data.originalScore;
  data.originalScore = null;
  data.originalScoreNormalized = null;
  data.originalScoreSource = null;
  data.originalScoreCleared = true;
  data.originalScoreClearedReason = 'outlet-publishes-no-critic-rating (tier 1d)';
  invalidateStarSidedAdjudication(data, data.originalScoreClearedReason);
  return true;
}

/**
 * The score fields a NEW review file (gather-reviews createReviewFile) may start with (BRO-5064).
 * Show Score hands every row a star rating, including rows for outlets that print none
 * (london-theatre), and createReviewFile used to store it as originalScore. The collect step's
 * discardNoRatingOutletScore only runs when the page is re-fetched, so the placeholder reached
 * review-texts and failed check-score-integrity. A no-rating outlet starts with no score at all
 * (not aggregatorStars either: see the note on discardNoRatingOutletScore).
 *
 * @param {object} reviewData  { outletId, scoreSource, originalRating, score }
 * @param {object} deps        { parseRating(rating, outletId), isAggregatorSource(scoreSource) }
 * @returns {{originalScore: *, aggregatorStars?: *}}
 */
function initialScoreFields(reviewData, deps) {
  const { outletId } = reviewData;
  if (publishesNoCriticRating(outletId)) return { originalScore: null };
  const parsed = reviewData.originalRating
    ? deps.parseRating(reviewData.originalRating, outletId)
    : (reviewData.score != null ? reviewData.score : null);
  if (deps.isAggregatorSource(reviewData.scoreSource)) return { originalScore: null, aggregatorStars: parsed };
  return { originalScore: parsed };
}

module.exports = { discardNoRatingOutletScore, initialScoreFields };
