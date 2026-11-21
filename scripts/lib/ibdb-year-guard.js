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

// IBDB production ids rise with time. Measured over every stored ibdbUrl (2026-11-10):
// the lowest id for any production opening in 2006 or later is 392567 (2005: 378059), while
// pre-2005 runs sit far below. So a show opening 2006+ whose url carries a smaller id points
// at an older production of the same title (BRO: wanted-2022 carried the 1928 play "Wanted"
// wanted-10398, so its page listed a 1928 cast). This catches the case the title/date guards
// miss: an original-run <title> has no "N Revival" year and its page date may not parse.
const IBDB_ID_FLOOR = 370000;
const IBDB_ID_FLOOR_FROM_YEAR = 2006;

// Numeric production id from /broadway-production/{slug}-{id}, or null (a slug with no trailing digits has none).
function ibdbProductionId(url) {
  const m = /-(\d+)\/?(?:[?#].*)?$/.exec(String(url || ''));
  return m ? parseInt(m[1], 10) : null;
}

// Why this stored/candidate IBDB url cannot be THIS show's production, or null when it may be.
//   'no-production-id'  the url has no numeric id, so it never resolves to a production page
//   'predates-show'     the id is below the floor for a show that opens in 2006 or later
function ibdbUrlRejectReason(showOrYear, ibdbUrl) {
  if (!ibdbUrl) return null;
  const id = ibdbProductionId(ibdbUrl);
  if (id == null) return 'no-production-id';
  const expected = typeof showOrYear === 'number' ? showOrYear : expectedShowYear(showOrYear);
  if (expected != null && expected >= IBDB_ID_FLOOR_FROM_YEAR && id < IBDB_ID_FLOOR) return 'predates-show';
  return null;
}

// One answer for every enrich/discover/cast path: is this IBDB match the wrong production?
// ibdb = { openingDate?, ibdbUrl? } (either may be missing).
function ibdbWrongProduction(show, ibdb) {
  if (!ibdb) return false;
  return ibdbYearMismatch(show, ibdb.openingDate) || ibdbUrlRejectReason(show, ibdb.ibdbUrl) != null;
}

module.exports = {
  ibdbYearMismatch, expectedShowYear, yearOf,
  ibdbProductionId, ibdbUrlRejectReason, ibdbWrongProduction, IBDB_ID_FLOOR, IBDB_ID_FLOOR_FROM_YEAR,
};
