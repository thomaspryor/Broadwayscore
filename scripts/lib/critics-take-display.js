'use strict';

/**
 * Critics' Take display mode for the show page's consensus slot (BRO-927).
 *
 * Before this, a missing consensus always fell back to the show's synopsis —
 * fine for an unopened show (nothing to summarize yet), misleading once
 * enough reviews exist (Fear of 13 had 21 scored reviews and showed its
 * documentary synopsis in the verdict slot). 'coming-soon' distinguishes
 * "not generated yet" from "nothing to say yet" so the UI never substitutes
 * unrelated copy for a missing verdict.
 *
 * Plain CommonJS (not .ts) so this can be require()'d directly from
 * tests/unit/*.test.mjs under plain `node --test`, no tsx loader needed —
 * src/app/show/[slug]/page.tsx imports it via a relative path (allowJs,
 * same pattern as src/lib/browse-slugs.ts → scripts/lib/broadway-seasons.js).
 */

const REVIEW_COUNT_FLOOR = 5;

/**
 * reviewCount here is show.criticScore.reviewCount (reviews.json entries),
 * NOT the generator's own count of review-text files it can read text out
 * of (scripts/generate-critic-consensus.js's loadReviewTexts). Those two
 * counts are not equal — scripts/lib/critic-consensus-eligibility.js
 * documents a measured ~14-show gap either direction (WE aggregator-star
 * reviews scored with no readable text, mainly). A show that clears this
 * floor by reviews.json count but never clears the generator's own
 * MIN_SCORED_REVIEWS by readable text would show 'coming-soon' forever.
 * Accepted for the same reason that file accepts it for its own caller: a
 * predicate shared across two counts that don't have the same source can
 * make the common case right, but is a mirror, not a proof.
 *
 * @param {boolean} hasConsensus
 * @param {boolean} hasCriticScore
 * @param {number} reviewCount
 * @param {boolean} hasSynopsis
 * @returns {'consensus'|'coming-soon'|'synopsis'|'none'}
 */
function getCriticsTakeDisplayMode(hasConsensus, hasCriticScore, reviewCount, hasSynopsis) {
  if (hasConsensus && hasCriticScore) return 'consensus';
  if (reviewCount >= REVIEW_COUNT_FLOOR) return 'coming-soon';
  if (hasSynopsis) return 'synopsis';
  return 'none';
}

module.exports = { getCriticsTakeDisplayMode, REVIEW_COUNT_FLOOR };
