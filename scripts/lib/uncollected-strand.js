'use strict';

const { datesFromDiscoveredReviews } = require('./opening-signal');

/**
 * Date-independent detection of review URLs we discovered and then never fetched.
 *
 * Why this is separate from every other coverage monitor
 * -----------------------------------------------------
 * Every existing coverage check keys off a show's opening window, so all of
 * them share one failure mode: a show whose date field is null drops out of
 * scope silently, and a check that never runs never fails. On 2026-08-12 that
 * cost two Off-Broadway openings their entire review sets — The Winter's Tale
 * (11 discovered URLs, 0 collected) and An American Daughter (9 discovered, 0
 * collected) — with a live NYT review, a Playbill Verdict article and a BWW
 * roundup all pointing at them, and not one alert anywhere. The collection
 * queue sorted them behind 2,800 shows and the gap audit skipped them, both
 * for the same reason: `openingDate` was null.
 *
 * So the STRAND half of this module deliberately reads no date field of the
 * show. Its question is only: "we wrote down a URL for a live show — did we
 * ever fetch it?" A check that depends on no date cannot be silenced by a
 * missing one, and that is the part that must never regress.
 *
 * The totalBlackout ESCALATION is different and does consult dates, because
 * "this show has no critics at all" is only alarming once press night has
 * happened. It reads show.status/openingDate first and falls back to review
 * dates, so a null openingDate alone cannot silence it — but a show wrongly
 * marked `previews` with a late previewsStartDate can. That residual exposure
 * is deliberate and bounded: the strand list still fires underneath it.
 *
 * `incompleteReason: 'not_attempted'` is the collector's own marker for
 * "Has URL but never scraped", so it is exact rather than inferred.
 */

/** Live statuses whose reviews are supposed to be on the site right now. */
const LIVE_STATUSES = new Set(['open', 'previews']);

/**
 * Hours a discovered URL may sit unfetched before it counts as stranded.
 *
 * 12h ≈ 1.5 cycles of the 3×-daily collector (04:30/10:00/18:00 UTC): long
 * enough that ordinary queue latency is not an alert, short enough that a
 * blackout is caught the morning after press night rather than a day later.
 * A 24h default would not have flagged The Winter's Tale on the night the
 * owner found it by eye — its reviews were 14h old.
 */
const DEFAULT_MAX_AGE_HOURS = 12;

/**
 * True when this review file is a URL we discovered and never fetched.
 *
 * Deliberately narrow: files that carry a rejection/exclusion verdict were
 * looked at and judged, which is a decision, not a strand. Only 'not_attempted'
 * means nothing ever tried.
 *
 * @param {object} review parsed review-text JSON
 * @returns {boolean}
 */
function isNeverAttempted(review) {
  if (!review || typeof review !== 'object') return false;
  if (!review.url) return false;
  if ((review.fullText || '').length > 0) return false;
  return review.incompleteReason === 'not_attempted';
}

/**
 * Age in hours of a discovered-but-unfetched file, or null if undatable.
 *
 * @param {object} review
 * @param {number} nowMs
 * @returns {number|null}
 */
function strandAgeHours(review, nowMs) {
  const seen = review && review.firstSeenAt;
  if (!seen) return null;
  const t = Date.parse(seen);
  if (Number.isNaN(t)) return null;
  return (nowMs - t) / 3600000;
}

/**
 * Has this show's press night demonstrably happened?
 *
 * Two independent kinds of evidence, strongest first:
 *  1. The show record itself says `open` and its openingDate has arrived. This
 *     is the authoritative statement and needs no review data at all.
 *  2. A clean discovered review carries a date on/after previews began and that
 *     date has arrived.
 *
 * (2) alone is not enough, and assuming it was is how the first cut of this
 * function went wrong. Measured on the live corpus 2026-08-13: 95 of 99
 * `not_attempted` files carry no parseable date, and ALL shows then sitting in
 * blackout shape yielded zero dates — so keying solely on review dates silenced
 * the alarm corpus-wide, including Matilda (Theatre Row), genuinely open since
 * 2026-08-06 with two discovered URLs and nothing collected.
 *
 * (1) also covers the nastiest shape: when a real review set is wrongly flagged
 * wrongProduction/wrongShow, the flags both CAUSE the blackout and erase the
 * dated evidence, so review data can never license the alarm. The show record
 * is the only witness left.
 *
 * @param {object} show
 * @param {string[]} openedDates dates from datesFromDiscoveredReviews
 * @param {string} today YYYY-MM-DD
 * @returns {boolean}
 */
function hasOpened(show, openedDates, today) {
  if (show.status === 'open' && show.openingDate && show.openingDate <= today) return true;
  // A future or garbage date must not license the alarm — the sibling signal
  // openSignalFromDiscovery applies the same isDateReached guard.
  return (openedDates || []).some(d => d <= today);
}

/**
 * Assess one show's review files.
 *
 * @param {{id: string, title?: string, status?: string}} show
 * @param {Array<{file: string, review: object}>} files
 * @param {{nowMs: number, maxAgeHours?: number}} opts
 * @returns {{showId: string, title: string, status: string, stranded: Array, usable: number, discovered: number, totalBlackout: boolean}|null}
 *          null when the show is not live (out of scope).
 */
function assessShow(show, files, { nowMs, maxAgeHours = DEFAULT_MAX_AGE_HOURS } = {}) {
  if (!show || !LIVE_STATUSES.has(show.status)) return null;

  const stranded = [];
  let usable = 0;
  let discovered = 0;
  // Evidence the show's press night has actually happened: at least one clean
  // discovered review carrying a real date on/after previews began.
  //
  // Skipped entirely without previewsStartDate — datesFromDiscoveredReviews
  // only filters out prior-production dates when it has that boundary, so
  // without it a 2003 revival's review would read as this run's press night.
  // openSignalFromDiscovery refuses to guess in the same situation; the
  // show-record branch of hasOpened() still covers these shows.
  const openedDates = show.previewsStartDate
    ? datesFromDiscoveredReviews((files || []).map(f => f.review), show)
    : [];
  const today = new Date(nowMs).toISOString().slice(0, 10);

  for (const { file, review } of files || []) {
    if (review && review.url) discovered++;
    if (review && (review.fullText || '').length > 200) usable++;
    if (!isNeverAttempted(review)) continue;
    const ageHours = strandAgeHours(review, nowMs);
    // An undatable strand still counts — a missing timestamp must not buy a
    // file an exemption, which is the same "null field silences the check"
    // bug this whole module exists to close.
    if (ageHours === null || ageHours >= maxAgeHours) {
      stranded.push({ file, url: review.url, outlet: review.outlet || null, ageHours });
    }
  }

  return {
    showId: show.id,
    title: show.title || show.id,
    status: show.status,
    stranded,
    usable,
    discovered,
    // The catastrophic shape: a live show the site shows no critics for at all,
    // while we hold its review URLs on disk. Threshold 2, not 3 — an
    // Off-Broadway show can have its whole press slate be two outlets, and a
    // blackout is a blackout at that size too.
    //
    // hasOpened() is load-bearing in BOTH directions, and the two failure modes
    // pull against each other:
    //   - Without it this fires on every show still in previews, which always
    //     has zero usable reviews. Abigail's Party tripped exactly that on
    //     2026-08-13 (previews 08-12, press night 08-19, six dead links to
    //     earlier revivals of the Mike Leigh play).
    //   - Keying it on review dates ALONE silences the alarm corpus-wide,
    //     because almost no uncollected file carries a parseable date. That
    //     over-correction shipped briefly the same day and hid a real blackout.
    // A monitor that cries wolf on unopened shows gets ignored; a monitor that
    // never fires is worse. Both are the failure that produced this incident.
    totalBlackout: usable === 0 && discovered >= 2 && hasOpened(show, openedDates, today),
  };
}

module.exports = {
  LIVE_STATUSES,
  DEFAULT_MAX_AGE_HOURS,
  isNeverAttempted,
  strandAgeHours,
  assessShow,
};
