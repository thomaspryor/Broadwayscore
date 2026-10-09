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

/**
 * Mirror of src/lib/tour-listing.ts isTourScored (data-core isTourListed): a
 * tour needs the market minimum of reviews (+2 when none is T1/T2) to have a
 * score (BRO-4601). `slim` is the public/data/shows/{id}.json object (rc, rv[].t).
 */
function isTourListedSlim(slim) {
  const { getMarketMinReviews } = require('./min-reviews');
  const rc = (slim && slim.rc) || 0;
  const top = ((slim && slim.rv) || []).filter(r => r && (r.t === 1 || r.t === 2)).length;
  return rc >= getMarketMinReviews('tour') + (top === 0 ? 2 : 0);
}

/**
 * Mirror of src/lib/tour-listing.ts isTourIndexable for the search index
 * (BRO-4931): a scored tour always; an unscored tour once it is not closed
 * and has a schedule. A closed or unscheduled unscored tour stays out of
 * search, like it stays noindex and out of the sitemap.
 * @param {object|null} slim public/data/shows/{id}.json
 * @param {string} status the show's status in shows.json
 * @param {boolean} hasSchedule data/tour-schedules.json has stops for the tour
 */
function isTourIndexableSlim(slim, status, hasSchedule) {
  if (isTourListedSlim(slim)) return true;
  return status !== 'closed' && !!hasSchedule;
}

module.exports = { buildShowsWithScores, isTourListedSlim, isTourIndexableSlim };
