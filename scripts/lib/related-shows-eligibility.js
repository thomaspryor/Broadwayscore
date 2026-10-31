/**
 * Pure decisions shared by generate-related-shows.js (kept here so tests can require() them).
 *
 * - isEligibleSource: which shows get their OWN recommendations generated. Shows with <5
 *   reviews used to be skipped, which left every show in previews with no curated picks (they
 *   fell back to a weak algorithmic ranking on web and a score-distance sort in the app).
 *   Active shows are the ones people look at, so they always qualify.
 * - closedPoolAllows / qualityBonus: the closed pool is large, so only shows critics liked
 *   are candidates, and well-reviewed ones win similarity ties. Mirrors data-core.ts
 *   getRelatedShowsAlgorithmic (RELATED_CLOSED_MIN_SCORE).
 */
const ACTIVE_STATUSES = new Set(['open', 'previews', 'upcoming']);
const MIN_REVIEWS_FOR_SOURCE = 5;
const CLOSED_MIN_SCORE = 60;

function isEligibleSource(show, reviewCount) {
  return reviewCount >= MIN_REVIEWS_FOR_SOURCE || ACTIVE_STATUSES.has(show.status);
}

/** Unscored candidates stay eligible (rare in the closed pool). */
function closedPoolAllows(score) {
  return score == null || score >= CLOSED_MIN_SCORE;
}

/** 0-5 points so well-reviewed shows win ties. */
function qualityBonus(score) {
  return Math.max(0, Math.min(5, (score ?? 0) / 20));
}

module.exports = { isEligibleSource, closedPoolAllows, qualityBonus, CLOSED_MIN_SCORE, MIN_REVIEWS_FOR_SOURCE };
