'use strict';

/**
 * Reject an IBDB date match whose production year is implausible for THIS show.
 *
 * Root cause of the 2026-06-28 clone-date bugs: enrich-ibdb-dates.js matches IBDB by
 * TITLE only, so a brand-new revival with no dates yet (a-few-good-men-2026) matched its
 * ORIGINAL production on IBDB and got stamped 1989-11-15 + openingDateSource:ibdb. Distinct
 * productions of the same title open decades apart; applying the wrong one's dates is the
 * Sunset Baby class CLAUDE.md already names.
 *
 * The show's expected year comes from (in order): an existing opening/previews date, else
 * the `{title}-{YYYY}` id suffix. A revival's id year is the SEASON year and the real
 * opening can be the next calendar year, so the default tolerance is 2 years; anything
 * larger means the IBDB result is a different production.
 */

function yearOf(dateStr) {
  if (!dateStr) return null;
  const y = parseInt(String(dateStr).slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

// The year this show is actually expected to play (not the namesake's).
function expectedShowYear(show) {
  if (!show) return null;
  return yearOf(show.openingDate)
    || yearOf(show.previewsStartDate)
    || (() => { const m = String(show.id || '').match(/-(\d{4})$/); return m ? parseInt(m[1], 10) : null; })();
}

/**
 * @param {object} show - the show being enriched
 * @param {string|null} ibdbOpeningDate - the candidate IBDB production's opening date
 * @param {object} [opts] - { toleranceYears = 2 }
 * @returns {boolean} true when the IBDB year is too far from the show's expected year (= wrong production)
 */
function ibdbYearMismatch(show, ibdbOpeningDate, opts = {}) {
  const { toleranceYears = 2 } = opts;
  const ibdbYear = yearOf(ibdbOpeningDate);
  const expected = expectedShowYear(show);
  if (ibdbYear == null || expected == null) return false; // can't validate → don't block
  return Math.abs(ibdbYear - expected) > toleranceYears;
}

module.exports = { ibdbYearMismatch, expectedShowYear, yearOf };
