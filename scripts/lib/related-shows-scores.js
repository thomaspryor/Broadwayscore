/**
 * Pure helper for generate-related-shows.js: each show's Critic Score as the
 * site displays it (rounded), for related-show quality bands and LLM context.
 *
 * Uses scripts/lib/slim-critic-score.js, the same decision that writes the
 * slim files' `cs` and that every website page matches (BRO-4312). It used to
 * raw-mean assignedScore with a flat 5-review minimum, which disagreed with the
 * tier-weighted score on the show page and ignored the per-market minimums
 * (BRO-4313 found it).
 *
 * Reviews must come from scripts/lib/load-reviews-with-blog.js's
 * loadReviewsWithBlog(), not a raw data/reviews.json read (card #1906).
 */

const { computeSlimCriticScore } = require('./slim-critic-score');

/**
 * @param {Array<{showId: string, assignedScore: number|null}>} reviews
 * @param {Array<{id: string}>} shows - shows.json rows (category/status/openingDate drive the gate)
 * @param {object} [outletRegistry] - data/outlet-registry.json `outlets`
 * @returns {Map<string, number>} showId -> rounded Critic Score (only shows the site gives a score)
 */
function buildScoreMap(reviews, shows, outletRegistry = {}) {
  const byShow = new Map();
  for (const r of reviews) {
    if (!byShow.has(r.showId)) byShow.set(r.showId, []);
    byShow.get(r.showId).push(r);
  }
  const scoreMap = new Map();
  for (const s of shows) {
    const { cs } = computeSlimCriticScore(s, byShow.get(s.id) || [], outletRegistry);
    if (cs != null) scoreMap.set(s.id, Math.round(cs));
  }
  return scoreMap;
}

module.exports = { buildScoreMap };
