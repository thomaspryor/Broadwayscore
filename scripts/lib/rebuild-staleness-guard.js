'use strict';

/**
 * Pure predicates for the rebuild-reviews.yml stale-checkout race: a
 * review-texts push landing between the job's checkout step and the
 * "Rebuild reviews.json" step is invisible to that step — it exits 0 with a
 * stale checkout and no warning (rebuild-all-reviews.js has no reason to
 * fail; the files simply aren't there yet).
 *
 * These two functions only COMPOSE decisions — they never decide what counts
 * as "scoreable" themselves. That predicate lives in
 * scripts/lib/review-guards.js (isIncludableForRebuild) and
 * scripts/lib/rebuild-helpers.js (getBestScore), per
 * memory/feedback_includability_predicates_must_be_canonical.md. The caller
 * (scripts/check-rebuild-staleness.js) is responsible for calling those.
 */

/**
 * Did review-texts advance between the job's checkout step and the point
 * right before the rebuild runs? Both SHAs must be present — an empty/missing
 * SHA (e.g. git command failed) never triggers a retry; fail closed on bad
 * input rather than forcing an unnecessary re-clone.
 *
 * @param {string} shaAtCheckout - HEAD of data/review-texts right after checkout
 * @param {string} shaBeforeRebuild - origin/main tip right before rebuild runs
 * @returns {boolean}
 */
function shouldRetryForStaleCheckout(shaAtCheckout, shaBeforeRebuild) {
  if (!shaAtCheckout || !shaBeforeRebuild) return false;
  return shaAtCheckout !== shaBeforeRebuild;
}

/**
 * Which of the given scoreable show ids have ZERO entries in reviews.json?
 * A non-empty result is the "the rebuild silently dropped a show" signal —
 * the caller decides how loudly to react (see check-rebuild-staleness.js).
 *
 * @param {string[]} scoreableShowIds - show ids with at least one file the
 *   caller determined would pass rebuild's real inclusion checks
 * @param {string[]} reviewsShowIds - reviews.json's reviews[].showId values
 * @returns {string[]} sorted, deduped show ids missing from reviews.json
 */
function findMissingScoreableShows(scoreableShowIds, reviewsShowIds) {
  const present = new Set(reviewsShowIds || []);
  const missing = new Set();
  for (const id of scoreableShowIds || []) {
    if (id && !present.has(id)) missing.add(id);
  }
  return [...missing].sort();
}

module.exports = { shouldRetryForStaleCheckout, findMissingScoreableShows };
