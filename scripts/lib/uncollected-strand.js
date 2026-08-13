'use strict';

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
 * So this module deliberately reads NO date field of the show. Its question is
 * only: "we wrote down a URL for a live show — did we ever fetch it?" A check
 * that depends on no date cannot be silenced by a missing one.
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
    totalBlackout: usable === 0 && discovered >= 2,
  };
}

module.exports = {
  LIVE_STATUSES,
  DEFAULT_MAX_AGE_HOURS,
  isNeverAttempted,
  strandAgeHours,
  assessShow,
};
