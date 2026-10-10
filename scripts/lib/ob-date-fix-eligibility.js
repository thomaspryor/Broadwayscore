'use strict';

/**
 * Off-Broadway date-fix eligibility (scripts/enrich-off-broadway-dates.js).
 *
 * The fixer's status allowlist admits only live/upcoming rows. Closed rows
 * are excluded because their slug/title may be reused by a later production,
 * and a schedule-article title hit would overwrite the historical entry's
 * dates — Romeo & Juliet Suite 2026 (status=closed) took a 2026-06-11 future
 * production's dates before the guard existed (/ship-check 2026-04-29).
 *
 * The 2026 data audit (S2-T11) found 92 OB rows with
 * openingDate === previewsStartDate (IBDB reports the first performance as
 * the opening) and 148 with no openingDate, most of them closed — so the
 * allowlist alone leaves them broken forever. `--include-closed-when-year-
 * matches` admits a closed row ONLY when the Playbill production page it was
 * matched to carries the same year as the row itself: a same-year production
 * page is the row's own production, not a later revival, so the Romeo &
 * Juliet Suite hazard cannot fire. A closed row matched by a source with no
 * production-page year (the schedule article, Lortel) is never eligible —
 * those sources list upcoming runs.
 *
 * Pure decision functions, extracted so the script's inline check and the
 * unit test (tests/unit/enrich-ob-dates-closed-year-match.test.mjs) call the
 * same code (CLAUDE.md §15).
 */

const { isRecentlyLive } = require('./show-liveness');

const ELIGIBLE_STATUSES = new Set(['open', 'previews', 'upcoming', 'announced']);

// Liveness for the OB date fixer: the four ELIGIBLE_STATUSES outright, never
// a closed row by recency — a closed row is admitted ONLY by the exact
// Playbill-year match below (the Romeo & Juliet Suite hazard is about title
// reuse, not about how recently the row closed). Reproduces the historical
// `ELIGIBLE_STATUSES.has(status)` by construction (audit S7-T7;
// tests/unit/show-liveness.test.mjs pins the equivalence).
const OB_DATE_FIX_LIVENESS = Object.freeze({ liveStatuses: Object.freeze([...ELIGIBLE_STATUSES]), allowClosed: false });

function toYear(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isInteger(n) && n >= 1000 && n <= 9999 ? n : null;
}

/**
 * The show's own production year: openingDate, else previewsStartDate, else
 * the id's trailing 4-digit year (catalog ids are `{slug}-{YYYY}`).
 * Returns a number, or null when none of the three carries a year.
 */
function getShowOpeningYear(show) {
  if (!show) return null;
  for (const d of [show.openingDate, show.previewsStartDate]) {
    if (typeof d === 'string' && /^\d{4}-/.test(d)) {
      const y = toYear(d.slice(0, 4));
      if (y !== null) return y;
    }
  }
  const m = String(show.id || '').match(/-(\d{4})$/);
  return m ? toYear(m[1]) : null;
}

/**
 * Pool admission: may this row enter the fixer's OB pool at all? Live and
 * upcoming statuses always; `closed` only under the flag. The exact-year
 * check happens per matched source in isEligibleForDateFix, once the
 * Playbill production-page year is known.
 */
function isStatusEligibleForDateFix(show, { includeClosedWhenYearMatches = false } = {}) {
  if (!show) return false;
  if (isRecentlyLive(show, OB_DATE_FIX_LIVENESS)) return true;
  return show.status === 'closed' && !!includeClosedWhenYearMatches;
}

/**
 * Final per-match decision. `playbillYear` is the year parsed from the
 * Playbill production page's <title> (or the production URL's trailing
 * year); pass null when the source carries no production-page year.
 *
 *   - open/previews/upcoming/announced → true (existing behaviour, year ignored)
 *   - closed → true only when the flag is set AND playbillYear equals the
 *     show's own year (getShowOpeningYear); an unknown year on either side
 *     is a mismatch
 *   - anything else (cancelled, postponed, transferred, …) → false
 */
function isEligibleForDateFix(show, playbillYear, { includeClosedWhenYearMatches = false } = {}) {
  if (!show) return false;
  if (isRecentlyLive(show, OB_DATE_FIX_LIVENESS)) return true;
  if (show.status !== 'closed' || !includeClosedWhenYearMatches) return false;
  const showYear = getShowOpeningYear(show);
  const pageYear = toYear(playbillYear);
  return showYear !== null && pageYear !== null && pageYear === showYear;
}

module.exports = {
  ELIGIBLE_STATUSES,
  OB_DATE_FIX_LIVENESS,
  getShowOpeningYear,
  isStatusEligibleForDateFix,
  isEligibleForDateFix,
};
