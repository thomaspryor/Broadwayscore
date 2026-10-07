/**
 * Pure helper for generate-related-shows.js: computes each show's rounded
 * average critic score from a review list (BRO-339 drift class, card #1906).
 *
 * Reviews must come from scripts/lib/load-reviews-with-blog.js's
 * loadReviewsWithBlog(), not a raw data/reviews.json read — otherwise a show
 * whose only score comes from a source folded in later in the pipeline (e.g.
 * blog-reviews-for-scoring.json) ranks with a wrong/missing avg here while
 * its show page renders a real Critic Score.
 */

/**
 * @param {Array<{showId: string, assignedScore: number|null}>} reviews
 * @param {Array<{id: string}>} shows
 * @returns {Map<string, number>} showId -> rounded avg score (only for shows with >=5 scored reviews)
 */
function buildScoreMap(reviews, shows) {
  const scoreMap = new Map();
  for (const s of shows) {
    const showReviews = reviews.filter(r => r.showId === s.id && r.assignedScore != null);
    if (showReviews.length >= 5) {
      const avg = showReviews.reduce((sum, r) => sum + r.assignedScore, 0) / showReviews.length;
      scoreMap.set(s.id, Math.round(avg));
    }
  }
  return scoreMap;
}

module.exports = { buildScoreMap };
