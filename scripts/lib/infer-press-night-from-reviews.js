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

// Minimum gap (days) between the current openingDate and the inferred press
// night before we apply a correction.
//
// DEFAULT (8): for a generic unconfirmed openingDate we only trust the inference
// when the review cluster is clearly a separate event a week+ later — a small
// gap could just be the normal review-the-morning-after lag on an
// already-correct press night, so we leave it alone.
//
// COLLAPSED (2): when openingDate === previewsStartDate the stored date is
// DEFINITIONALLY the first-preview date (the TodayTix "first performance" bug),
// not press night. Any review cluster after it is a real press wave, so even a
// 2-7 day gap is a legitimate correction. West End fringe runs preview for only
// a few days, so their press night always lands inside the default 8-day floor —
// which is why 32 collapsed WE shows sat uncorrected. The ≥2-reviews-in-3-days
// cluster check still guards against a single early outlier. (gap < 2 is a
// no-op: press night = earliest review − 1 ≈ the stored date already.)
const DEFAULT_MIN_GAP_DAYS = 8;
const COLLAPSED_MIN_GAP_DAYS = 2;

// REVERSE (2): the mirror-image failure — a collapsed TodayTix date that is
// LATER than the real press night, with the review cluster arriving BEFORE it.
// BRO-2280 / the-hunger-games-on-stage-west-end-2025: stored openingDate
// 2025-11-28 (collapsed with previewsStartDate) but an 18-outlet cluster on
// 2025-11-12/11-13, i.e. 16 days EARLIER. The forward filter
// (publishDate > openingMs) made that cluster invisible, so the show needed a
// manual hardcode instead of the daily WE cron catching it.
const REVERSE_MIN_GAP_DAYS = 2;

// Widest gap we still treat as the same production's press wave (both
// directions). Beyond this the reviews are almost certainly a prior run /
// out-of-town tryout wrongly attached to this show entry, not a date bug.
const MAX_GAP_DAYS = 90;

// Days to subtract from the earliest clustered review date to get press night.
//
// FORWARD (1): the original rule — "critics attend the press performance the
// evening before they publish".
//
// REVERSE (0): measured against the 46 West End / Off-West End shows that have
// a TRUSTED openingDate (theatremonkey / playbill / ibdb) and >=3 reviews, the
// offset between press night and the earliest clustered review date is
// 0 days in 32 cases, +1 in 8, and the rest scattered — i.e. UK press-night
// embargoes usually lift the same evening, so the earliest cluster date IS
// press night. The reverse branch is new logic with no back-compat debt, so it
// uses the empirically modal offset. The forward branch keeps its -1 because
// changing it would silently move 30+ already-corrected shows; that
// re-alignment is tracked separately rather than smuggled into this fix.
const FORWARD_OFFSET_DAYS = 1;
const REVERSE_OFFSET_DAYS = 0;

/**
 * Cluster probe used by both directions: given ascending review publish dates,
 * require ≥3 of them and ≥2 falling within 3 days of the EARLIEST one.
 * A lone early outlier is not a press wave.
 *
 * @param {Array<string>} sortedDates - ascending ISO-ish date strings.
 * @returns {{earliestIso:string, earliestMs:number, clusterSize:number}|null}
 */
function findEarliestCluster(sortedDates) {
  if (sortedDates.length < 3) return null;

  const earliestIso = new Date(sortedDates[0]).toISOString().split('T')[0];
  const earliestMs = new Date(earliestIso).getTime();

  const nearEarliest = sortedDates.filter(d => {
    const ms = new Date(d).getTime();
    return ms >= earliestMs && ms <= earliestMs + 3 * DAY_MS;
  });
  if (nearEarliest.length < 2) return null;

  return { earliestIso, earliestMs, clusterSize: nearEarliest.length };
}

/**
 * Infer press-night dates from review-publish clustering.
 *
 * Rules (taken from the original WE Phase 4 logic so behavior is preserved):
 *   - Show must have an unconfirmed openingDateSource.
 *   - Show must have ≥3 valid review publish dates AFTER the current openingDate.
 *   - The earliest publish date must have ≥2 reviews within a 3-day window
 *     (clustering check — single early outlier doesn't qualify).
 *   - Inferred press night = earliest review date − 1 day.
 *   - Gap between current openingDate and the earliest review must be within
 *     [minGap, 90] days, where minGap is 8 by default but 2 for COLLAPSED shows
 *     (openingDate === previewsStartDate — see the floor docs above). Below
 *     minGap = treat as the same press cycle (no correction); >90 = stale data.
 *
 * Reverse direction (BRO-2280), tried only when the forward rules did NOT fire:
 *   - Show must be COLLAPSED (openingDate === previewsStartDate). A non-collapsed
 *     openingDate is a real press-night claim; reviews predating it are far more
 *     likely contamination than a backwards date, so we leave those alone.
 *   - Same ≥3-reviews + ≥2-within-3-days cluster check, applied to the reviews
 *     published BEFORE the stored openingDate.
 *   - Inferred press night = earliest clustered review date (offset 0 — see
 *     REVERSE_OFFSET_DAYS), gap in [2, 90] days.
 *   - previewsStartDate is set to null, not fabricated.
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

    // Collapsed (openingDate === previewsStartDate) => the stored date is
    // DEFINITIONALLY the first-preview date (the TodayTix "first performance"
    // bug), not press night. Both the lowered forward floor and the entire
    // reverse branch below are gated on it.
    const isCollapsed = !!show.previewsStartDate && show.openingDate === show.previewsStartDate;

    const showDates = reviews
      .filter(r => r.showId === show.id)
      .map(r => r.publishDate)
      .filter(d => d && !Number.isNaN(new Date(d).getTime()));

    // --- Direction 1 (original): review cluster AFTER the stored date ---
    const afterDates = showDates.filter(d => new Date(d).getTime() > openingMs).sort();
    const afterCluster = findEarliestCluster(afterDates);

    if (afterCluster) {
      const gapDays = Math.round((afterCluster.earliestMs - openingMs) / DAY_MS);
      const minGapDays = isCollapsed ? COLLAPSED_MIN_GAP_DAYS : DEFAULT_MIN_GAP_DAYS;

      if (gapDays >= minGapDays && gapDays <= MAX_GAP_DAYS) {
        const pressNightIso = new Date(afterCluster.earliestMs - FORWARD_OFFSET_DAYS * DAY_MS)
          .toISOString().split('T')[0];

        inferred.push({
          id: show.id,
          title: show.title,
          slug: show.slug,
          direction: 'forward',
          gapDays,
          isCollapsed,
          clusterSize: afterCluster.clusterSize,
          earliestReviewIso: afterCluster.earliestIso,
          changes: [
            { field: 'previewsStartDate', old: show.previewsStartDate, new: show.openingDate },
            { field: 'openingDate', old: show.openingDate, new: pressNightIso },
            { field: 'openingDateSource', old: show.openingDateSource, new: 'inferred-from-reviews' },
          ],
        });
        continue;
      }
    }

    // --- Direction 2 (BRO-2280): review cluster BEFORE the stored date ---
    // Only for collapsed shows. On a non-collapsed show the stored openingDate
    // is a real (if unconfirmed) press-night claim, and reviews predating it
    // are far more likely to be contamination — a prior run, an out-of-town
    // tryout, or a wrong-show attachment — than a backwards date. A collapsed
    // date carries no such claim, so a pre-date press wave is the better
    // explanation. Reaching here also means the forward branch did NOT fire,
    // so we never pick a direction when both waves qualify.
    if (!isCollapsed) continue;

    const beforeDates = showDates.filter(d => new Date(d).getTime() < openingMs).sort();
    const beforeCluster = findEarliestCluster(beforeDates);
    if (!beforeCluster) continue;

    // gapDays is how far BEFORE the stored date the cluster sits (positive).
    const gapDays = Math.round((openingMs - beforeCluster.earliestMs) / DAY_MS);
    if (gapDays < REVERSE_MIN_GAP_DAYS) continue;
    if (gapDays > MAX_GAP_DAYS) continue;

    const pressNightIso = new Date(beforeCluster.earliestMs - REVERSE_OFFSET_DAYS * DAY_MS)
      .toISOString().split('T')[0];

    // The old openingDate was the collapsed first-performance date, which is
    // now AFTER the inferred press night — keeping it as previewsStartDate
    // would be an unambiguous data error (validate-data.js hard-errors on
    // previews-after-opening). We have no evidence for the real preview start,
    // so null it rather than fabricate one; the TM/Playbill phases backfill it
    // on a later run if an authoritative source ever lists it.
    inferred.push({
      id: show.id,
      title: show.title,
      slug: show.slug,
      direction: 'reverse',
      gapDays,
      isCollapsed,
      clusterSize: beforeCluster.clusterSize,
      earliestReviewIso: beforeCluster.earliestIso,
      changes: [
        { field: 'previewsStartDate', old: show.previewsStartDate, new: null },
        { field: 'openingDate', old: show.openingDate, new: pressNightIso },
        { field: 'openingDateSource', old: show.openingDateSource, new: 'inferred-from-reviews' },
      ],
    });
  }

  return inferred;
}

module.exports = {
  inferPressNightFromReviews,
  DEFAULT_MIN_GAP_DAYS,
  COLLAPSED_MIN_GAP_DAYS,
  REVERSE_MIN_GAP_DAYS,
  MAX_GAP_DAYS,
  // Exported for tests / debug only — call sites use inferPressNightFromReviews.
  findEarliestCluster,
};
