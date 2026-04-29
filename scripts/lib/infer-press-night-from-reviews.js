/**
 * infer-press-night-from-reviews.js
 *
 * Heuristic: when a show's openingDate source is unconfirmed AND no external
 * source (IBDB, Theatremonkey, Playbill schedule article) can supply a real
 * press night, we can sometimes infer the press night from the cluster of
 * earliest critic-review publish dates. Critics attend the press performance
 * the evening before they publish; a tight cluster of reviews on date X
 * implies press night was X−1.
 *
 * History: this logic was inline in scripts/enrich-west-end-dates.js Phase 4
 * (lines 595-646). Lifted to lib/ on 2026-04-28 so the new off-Broadway date
 * script can reuse it OR explicitly disable it. (Reviewer-flagged risk: OB
 * shows have sparser review counts than WE, so the inference fabricates dates
 * more easily. Each call site decides whether to enable.)
 *
 * Usage:
 *   const { inferPressNightFromReviews } = require('./lib/infer-press-night-from-reviews');
 *   const inferences = inferPressNightFromReviews({
 *     candidateShows,
 *     reviews: allReviews,    // array from data/reviews.json
 *     enabled: true,           // false ⇒ no-op for sparse-review markets
 *     skipShowIds: new Set([...]),  // shows already corrected by primary sources
 *   });
 *   // returns: [{ id, title, slug, changes: [{field, old, new}, ...] }]
 */

'use strict';

const { isUnconfirmedDateSource } = require('./date-source-confidence');

const DAY_MS = 86400000;

/**
 * Infer press-night dates from review-publish clustering.
 *
 * Rules (taken from the original WE Phase 4 logic so behavior is preserved):
 *   - Show must have an unconfirmed openingDateSource.
 *   - Show must have ≥3 valid review publish dates AFTER the current openingDate.
 *   - The earliest publish date must have ≥2 reviews within a 3-day window
 *     (clustering check — single early outlier doesn't qualify).
 *   - Inferred press night = earliest review date − 1 day.
 *   - Gap between current openingDate and inferred press night must be 8-90 days.
 *     (≤7 days = same press cycle, no correction needed; >90 days = stale data.)
 *
 * @param {object} opts
 * @param {Array<object>} opts.candidateShows - shows to consider.
 * @param {Array<object>} opts.reviews - all reviews from data/reviews.json.
 * @param {boolean} [opts.enabled=true] - false skips the entire phase.
 * @param {Set<string>} [opts.skipShowIds=new Set()] - shows already corrected.
 * @returns {Array<{id:string, title:string, slug:string, changes:Array}>}
 */
function inferPressNightFromReviews({ candidateShows, reviews, enabled = true, skipShowIds = new Set() }) {
  if (!enabled) return [];
  if (!Array.isArray(candidateShows) || !Array.isArray(reviews)) return [];

  const inferred = [];

  for (const show of candidateShows) {
    if (skipShowIds.has(show.id)) continue;
    if (!isUnconfirmedDateSource(show)) continue;
    if (!show.openingDate) continue;

    const openingMs = new Date(show.openingDate).getTime();
    if (Number.isNaN(openingMs)) continue;

    const validDates = reviews
      .filter(r => r.showId === show.id)
      .map(r => r.publishDate)
      .filter(d => d && !Number.isNaN(new Date(d).getTime()) && new Date(d).getTime() > openingMs)
      .sort();

    if (validDates.length < 3) continue;

    const earliestIso = new Date(validDates[0]).toISOString().split('T')[0];
    const earliestMs = new Date(earliestIso).getTime();

    // Cluster check: ≥2 reviews within 3 days of the earliest one.
    const nearEarliest = validDates.filter(d => {
      const ms = new Date(d).getTime();
      return ms >= earliestMs && ms <= earliestMs + 3 * DAY_MS;
    });
    if (nearEarliest.length < 2) continue;

    const pressNightMs = earliestMs - DAY_MS;
    const pressNightIso = new Date(pressNightMs).toISOString().split('T')[0];
    const gapDays = Math.round((earliestMs - openingMs) / DAY_MS);

    if (gapDays <= 7) continue;
    if (gapDays > 90) continue;

    inferred.push({
      id: show.id,
      title: show.title,
      slug: show.slug,
      gapDays,
      clusterSize: nearEarliest.length,
      changes: [
        { field: 'previewsStartDate', old: show.previewsStartDate, new: show.openingDate },
        { field: 'openingDate', old: show.openingDate, new: pressNightIso },
        { field: 'openingDateSource', old: show.openingDateSource, new: 'inferred-from-reviews' },
      ],
    });
  }

  return inferred;
}

module.exports = { inferPressNightFromReviews };
