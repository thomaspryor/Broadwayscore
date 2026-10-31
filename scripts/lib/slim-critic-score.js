/**
 * The slim-file Critic Score decision: given a show and its reviews, the
 * deduped review list, the scorer result, and the `cs` that
 * scripts/generate-mobile-show-details.js writes to public/data/shows/{id}.json
 * (the value scripts/lib/canonical-critic-scores.ts getCriticScore() reads).
 *
 * Extracted from the generator (BRO-4312) so
 * tests/unit/critic-score-canonical-parity.test.ts can require the real
 * decision and check every website page's displayed score against it.
 */

'use strict';

const { computeCriticScore } = require('./compute-critic-score');
const { dedupByCritic } = require('./dedup-by-critic');
const { shouldHideReviews, isCuratedHistoricalShow } = require('./should-hide-reviews');
const { hasEnoughReviews } = require('./min-reviews');

/**
 * @param {{ id: string, status?: string, category?: string, type?: string, openingDate?: string }} show
 * @param {Array<object>} rawShowReviews - this show's reviews from loadReviewsWithBlog()
 * @param {object} outletRegistry - data/outlet-registry.json `outlets`
 * @returns {{ showReviews: Array<object>, scoreResult: ({ s: number, rc: number, t1: number, t2: number } | null), cs: (number | null), rc: (number | null) }}
 */
function computeSlimCriticScore(show, rawShowReviews, outletRegistry) {
  // Critic-level dedup: one review per (outlet, critic), most recent wins.
  const showReviews = dedupByCritic(rawShowReviews || []);
  // Pre-2005 closed shows (not curated) and announced shows carry no score:
  // mirrors src/config/scoring.ts shouldHideReviews + engine.ts computeShowData.
  const hideReviews = shouldHideReviews(show) || show.status === 'announced';
  const scoreResult = hideReviews ? null : computeCriticScore(showReviews, outletRegistry, show.category, show.type);
  // Same display gate as the website's score badges (min-reviews.js).
  const hasEnough = !!scoreResult && hasEnoughReviews(
    scoreResult.rc, show.category, scoreResult.t1 + scoreResult.t2, isCuratedHistoricalShow(show.id),
  );
  return {
    showReviews,
    scoreResult,
    cs: hasEnough ? scoreResult.s : null,
    rc: hasEnough ? scoreResult.rc : null,
  };
}

module.exports = { computeSlimCriticScore };
