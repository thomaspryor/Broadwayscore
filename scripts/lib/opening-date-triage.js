/**
 * opening-date-triage.js (BRO-7275)
 *
 * Decides whether a press-cluster date that differs from the stored
 * openingDate / previewsStartDate is a real discrepancy or the audit's own
 * artifact. Five "Opening-date audit: show need review" cards in 30 days
 * (billy-crystal-860-2026 twice, other-desert-cities-2026, ...) were all the
 * same artifact: opening-night party/photo coverage is PUBLISHED the day after
 * the show opened ("Toast Billy Crystal at 860's Opening Night", "Photo Op ...
 * Oct 19"), the press-cluster extractor reads that publication date as the
 * opening date, and every case turned out to be stored-date-correct.
 *
 * Rule: for an `opening` field of a status='open' show whose stored date is
 * already in the past, a press date exactly 1 day later is an artifact.
 * Everything else (previews-start shifts, >1 day, not-yet-opened shows,
 * press date EARLIER than stored) still flags.
 */
const DAY = 86400000;

function dayDiff(a, b) {
  return Math.round((Date.parse(a) - Date.parse(b)) / DAY);
}

/** @returns {{flag: boolean, reason: string}} */
function triageOpeningFinding({ fieldType, stored, discoveredDate, today, status }) {
  if (!stored || !discoveredDate) return { flag: true, reason: 'no-stored-date-or-no-press-date' };
  if (fieldType !== 'opening') return { flag: true, reason: 'not-opening-field' };
  // Only a show that has actually opened: a show still in previews with a past
  // stored date is the likeliest real delay and must still flag.
  if (status !== 'open') return { flag: true, reason: 'not-open-status' };
  if (Date.parse(stored) >= Date.parse(today)) return { flag: true, reason: 'not-yet-opened' };
  if (dayDiff(discoveredDate, stored) === 1) return { flag: false, reason: 'next-day-opening-night-coverage' };
  return { flag: true, reason: 'date-differs' };
}

module.exports = { triageOpeningFinding };
