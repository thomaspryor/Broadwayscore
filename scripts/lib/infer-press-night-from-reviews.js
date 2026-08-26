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
const { normalizeDate } = require('./date-utils');
const { isWithinPriorRun, isWithinTourLeg } = require('./wrong-production-autoclear');

const DAY_MS = 86400000;

// Day-precision publish dates only. The corpus is 17,625 bare YYYY-MM-DD plus
// 123 month-only values ('2015-07'); both `new Date('2015-07')` and
// date-utils' normalizeDate() resolve a month-only value to the 1st, which
// would invent a press night on a day nobody published. So the raw string has
// to carry an explicit day BEFORE it is normalized. normalizeDate then does
// the calendar validation and takes the literal date part of an ISO timestamp,
// so a timezone offset can never shift the day.
const DAY_PRECISION_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/;

function dayPrecisionDate(raw) {
  if (typeof raw !== 'string' || !DAY_PRECISION_RE.test(raw.trim())) return null;
  return normalizeDate(raw);
}

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

// Minimum reviews in the reverse cluster. The forward probe's floor of 2 means
// "one corroborator", which is enough there because the stored date is already
// known-wrong in a known direction. Going backwards there is no such anchor —
// the stored date could be perfectly fine and the early reviews contamination —
// so the reverse wave has to be a genuine multi-outlet press night.
const REVERSE_MIN_CLUSTER = 3;

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
// uses the empirically modal offset.
//
// The forward branch keeps its -1, which that same measurement says is the
// modally WRONG answer — but changing it re-dates every show already stamped
// 'inferred-from-reviews' (175 in a forced-collapse sweep of all shows), which
// is an owner call, not a side effect of this fix. Shipping two offsets for the
// same physics is a known trap: BRO-2489 tracks collapsing them into one.
// https://linear.app/broadway-scorecard/issue/BRO-2489
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
 * Reverse-direction cluster probe. Unlike findEarliestCluster (which anchors on
 * the EARLIEST date, correct when scanning forward from a known-too-early
 * date), this scans every candidate anchor and returns the BIGGEST 3-day
 * window, breaking ties toward the latest.
 *
 * Anchoring on the earliest date is wrong going backwards: the earliest
 * pre-date reviews are the likeliest contamination — a prior run or an
 * out-of-town tryout wrongly attached to the show entry (see
 * the-enormous-crocodile-west-end-2026, which carries reviews from three
 * separate runs). The real press wave is the dominant cluster, not the oldest.
 *
 * Cluster size is counted in DISTINCT OUTLETS, not rows. A press night is a
 * multi-outlet event; three re-ingested rows from one outlet are not one, and
 * the corpus does carry same-outlet duplicates (scripts/lib/merge-reviews-json.js
 * has dedicated same-identity dedup for exactly this reason).
 *
 * @param {Array<{date:string, outlet:string}>} entries - ascending by date.
 * @returns {{anchorIso:string, anchorMs:number, clusterSize:number, rowCount:number}|null}
 */
function findDominantCluster(entries) {
  if (entries.length < 3) return null;

  let best = null;
  for (const { date: anchorIso } of entries) {
    const anchorMs = new Date(anchorIso).getTime();
    const inWindow = entries.filter(e => {
      const ms = new Date(e.date).getTime();
      return ms >= anchorMs && ms <= anchorMs + 3 * DAY_MS;
    });
    const outlets = new Set(inWindow.map(e => e.outlet)).size;
    // `>=` so a tie resolves to the LATEST anchor (entries are ascending).
    if (!best || outlets >= best.clusterSize) {
      best = { anchorIso, anchorMs, clusterSize: outlets, rowCount: inWindow.length };
    }
  }
  return best;
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
 *   - The stored openingDate must already be in the past.
 *   - Of the reviews published BEFORE the stored date (bare YYYY-MM-DD only),
 *     take the BIGGEST 3-day cluster, not the earliest — the earliest pre-date
 *     reviews are the likeliest contamination. It must hold ≥3 reviews and
 *     outweigh both the rest of the pre-date reviews and everything published
 *     on or after the stored date.
 *   - Inferred press night = that cluster's anchor date (offset 0 — see
 *     REVERSE_OFFSET_DAYS), gap in [2, 90] days.
 *   - previewsStartDate is set to null, not fabricated, and the source is
 *     stamped 'inferred-from-reviews-reverse' (deliberately off the
 *     press-night-trust.js whitelist).
 *
 * @param {object} opts
 * @param {Array<object>} opts.candidateShows - shows to consider.
 * @param {Array<object>} opts.reviews - all reviews from data/reviews.json.
 * @param {boolean} [opts.enabled=true] - false skips the entire phase.
 * @param {Set<string>} [opts.skipShowIds=new Set()] - shows already corrected.
 * @param {number} [opts.now=Date.now()] - injectable clock; the reverse branch
 *   refuses to back-date a show whose stored openingDate is still in the future.
 * @returns {Array<{id:string, title:string, slug:string, changes:Array}>}
 */
function inferPressNightFromReviews({ candidateShows, reviews, enabled = true, skipShowIds = new Set(), now = Date.now() }) {
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

    const showReviews = reviews.filter(r => r.showId === show.id);
    const showDates = showReviews
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

    // Never back-date a show whose stored date has not arrived yet. An
    // unopened show with reviews already attached is a contamination signal,
    // not a date bug — and a wrong correction there is the expensive kind: it
    // flips the show to 'open', shuts the pre-opening polling window, and the
    // real press night passes uncovered. Once the stored date is in the past
    // the show is open either way, so the downside collapses to a wrong date.
    if (openingMs > now) continue;

    // dayPrecisionDate (see above) instead of raw new Date(): month-only values
    // cannot anchor a press night and timezone offsets cannot shift the day.
    // The forward branch predates this and is left byte-identical on purpose
    // (see FORWARD_OFFSET_DAYS); BRO-2489 tracks applying it to both directions.
    //
    // Reviews inside a declared priorRuns / tourLegs window are dropped up
    // front: those legitimately predate this run's press night and are NOT
    // evidence that the stored date is wrong. Every other date-sensitive guard
    // in this codebase makes the same exemption (date-guard.js:92,
    // date-plausibility.js:92) — omitting it here would let a returning
    // production's earlier run overwrite the current run's opening date.
    const beforeEntries = showReviews
      .map(r => ({ date: dayPrecisionDate(r.publishDate), outlet: r.outlet || r.outletId || r.url || 'unknown' }))
      .filter(e => e.date && new Date(e.date).getTime() < openingMs)
      .filter(e => !isWithinPriorRun(e.date, show.priorRuns) && !isWithinTourLeg(e.date, show.tourLegs))
      .sort((a, b) => a.date.localeCompare(b.date));

    const cluster = findDominantCluster(beforeEntries);
    if (!cluster) continue;
    if (cluster.clusterSize < REVERSE_MIN_CLUSTER) continue;

    // Dominance, both ways. The cluster must outweigh:
    //   (a) the rest of the pre-date reviews — otherwise a prior run's reviews
    //       sitting alongside the real wave can win; and
    //   (b) everything published on or after the stored date — the forward
    //       branch is floored at COLLAPSED_MIN_GAP_DAYS, so a show can have a
    //       big legitimate press wave 1 day after the stored date that forward
    //       declines, and a few earlier strays must not drag the date back.
    // Measured on a forced-collapse sweep of all ~2,900 shows, pre-opening
    // review dates are common enough (preview-period notices, prior runs,
    // imprecise historical publishDates) that "some reviews exist before the
    // stored date" is not on its own sufficient evidence.
    const restOfBefore = beforeEntries.length - cluster.rowCount;
    const atOrAfterCount = showReviews
      .map(r => dayPrecisionDate(r.publishDate))
      .filter(d => d && new Date(d).getTime() >= openingMs).length;
    if (cluster.rowCount < restOfBefore) continue;
    if (cluster.rowCount < atOrAfterCount) continue;

    // gapDays is how far BEFORE the stored date the cluster sits (positive).
    const gapDays = Math.round((openingMs - cluster.anchorMs) / DAY_MS);
    if (gapDays < REVERSE_MIN_GAP_DAYS) continue;
    if (gapDays > MAX_GAP_DAYS) continue;

    const pressNightIso = new Date(cluster.anchorMs - REVERSE_OFFSET_DAYS * DAY_MS)
      .toISOString().split('T')[0];

    // The old openingDate was the collapsed first-performance date, which is
    // now AFTER the inferred press night — keeping it as previewsStartDate
    // would be an unambiguous data error (validate-data.js hard-errors on
    // previews-after-opening). We have no evidence for the real preview start,
    // so null it rather than fabricate one; the TM/Playbill phases backfill it
    // on a later run if an authoritative source ever lists it.
    //
    // The source string is deliberately NOT the forward branch's
    // 'inferred-from-reviews': that value is on the press-night-trust.js
    // whitelist, i.e. trusted enough to open pre-opening review polling on an
    // unopened show. A reverse inference is a weaker claim built on reviews
    // that could belong to another production, so it stays off that whitelist
    // (unlisted sources default to untrusted there) and stays greppable for
    // audit. It IS on date-source-confidence.js's unconfirmed list, so a later
    // Theatremonkey/Playbill entry can still overwrite it — a wrong reverse
    // inference self-corrects the moment an authoritative source appears
    // instead of being terminal. That does not re-fire this branch: the
    // corrected show is no longer collapsed (previewsStartDate is null), and
    // the whole cluster now sits on/after the new openingDate.
    inferred.push({
      id: show.id,
      title: show.title,
      slug: show.slug,
      direction: 'reverse',
      gapDays,
      isCollapsed,
      clusterSize: cluster.clusterSize,
      earliestReviewIso: cluster.anchorIso,
      changes: [
        { field: 'previewsStartDate', old: show.previewsStartDate, new: null },
        { field: 'openingDate', old: show.openingDate, new: pressNightIso },
        { field: 'openingDateSource', old: show.openingDateSource, new: 'inferred-from-reviews-reverse' },
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
  REVERSE_MIN_CLUSTER,
  MAX_GAP_DAYS,
  // Exported for tests / debug only — call sites use inferPressNightFromReviews.
  findEarliestCluster,
  findDominantCluster,
  dayPrecisionDate,
};
