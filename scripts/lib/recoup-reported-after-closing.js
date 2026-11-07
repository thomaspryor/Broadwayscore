// One rule for "this recoupment was reported after the show closed", shared by
// the site (src/lib/commercial-metrics.ts) and the weekly newsletter
// (scripts/newsletter/generate.mjs) so neither prints weeks-from-opening for a
// report month past the run (Purpose: "~65 weeks" for a 24-week run).
//
// recoupedDate is the month a recoupment was REPORTED, not always when it
// happened: only some sources say it came after closing, others announce it
// later. So this claims only "reported after closing".

/**
 * True when the YYYY-MM report month is later than the closing date's month.
 * Compared as YYYY-MM strings so the machine's timezone cannot move a show that
 * closes on the 1st across a month boundary. Year-only, missing or malformed
 * dates are false.
 * @param {string | null | undefined} recoupedDate
 * @param {string | null | undefined} closingDate
 * @returns {boolean}
 */
function recoupReportedAfterClosing(recoupedDate, closingDate) {
  const m = /^(\d{4})-(\d{2})$/.exec((recoupedDate ?? '').trim());
  const close = /^(\d{4}-\d{2})-\d{2}/.exec((closingDate ?? '').trim());
  if (!m || !close) return false;
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return false;
  return `${m[1]}-${m[2]}` > close[1];
}

/**
 * Weeks from `startDate` (opening night, or the commercial start) to the middle
 * of the YYYY-MM report month, as the newsletter prints "in N weeks". Null when
 * the report month is past the run's closing (reported after closing: weeks
 * from opening say nothing about how long recouping took), when either date is
 * missing or malformed, or when the result is not positive.
 * @param {string | null | undefined} startDate YYYY-MM-DD
 * @param {string | null | undefined} recoupedDate YYYY-MM
 * @param {string | null | undefined} closingDate YYYY-MM-DD
 * @param {boolean} [dateIsEstimate] the record's isEstimate.recoupedDate: our own date, never counted
 * @returns {number | null}
 */
function newsletterWeeksToRecoup(startDate, recoupedDate, closingDate, dateIsEstimate = false) {
  if (!startDate || !recoupedDate || dateIsEstimate) return null;
  if (recoupReportedAfterClosing(recoupedDate, closingDate)) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(recoupedDate);
  if (!m) return null;
  const recoupMid = new Date(`${m[1]}-${m[2]}-15T12:00:00`);
  const open = new Date(startDate + 'T12:00:00');
  const weeks = Math.round((recoupMid - open) / (7 * 86400000));
  return isFinite(weeks) && weeks > 0 ? weeks : null;
}

module.exports = { recoupReportedAfterClosing, newsletterWeeksToRecoup };
