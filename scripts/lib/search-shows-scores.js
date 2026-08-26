/**
 * Pure helper for generate-search-shows.js: decides which show IDs count as
 * "has a score" for the search index (BRO-339).
 *
 * data/reviews.json alone is not the full picture of what a show page
 * renders — it's missing any score source folded in later in the pipeline
 * (blog-reviews-for-scoring.json today; whatever comes next), unlike every
 * other score-computing script, which is required to go through
 * scripts/lib/load-reviews-with-blog.js. Rather than chase each such source
 * individually, this unions in the ids whose public/data/shows/{id}.json
 * already carries a non-null `cs` — the actual rendered Critic Score (see
 * scripts/lib/canonical-critic-scores.ts).
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {Array<{showId: string, assignedScore: number|null}>} reviews
 * @param {Array<{id: string}>} shows
 * @param {string} publicShowsDir - path to public/data/shows/
 * @returns {Set<string>}
 */
function buildShowsWithScores(reviews, shows, publicShowsDir) {
  const showsWithScores = new Set();
  for (const review of reviews) {
    if (review.assignedScore != null) {
      showsWithScores.add(review.showId);
    }
  }

  if (fs.existsSync(publicShowsDir)) {
    for (const show of shows) {
      if (showsWithScores.has(show.id)) continue;
      const slimPath = path.join(publicShowsDir, `${show.id}.json`);
      if (!fs.existsSync(slimPath)) continue;
      try {
        const slim = JSON.parse(fs.readFileSync(slimPath, 'utf-8'));
        if (typeof slim.cs === 'number') showsWithScores.add(show.id);
      } catch {
        // Corrupt/partial slim file — fall back to reviews.json-only signal
      }
    }
  }

  return showsWithScores;
}

module.exports = { buildShowsWithScores };
