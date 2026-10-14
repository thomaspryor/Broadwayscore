/**
 * todaytix-reopen-guard.js
 *
 * Decides whether a TodayTix `/api/v2/shows` listing is positive evidence
 * that a show is actually bookable — not just present-with-matching-title in
 * the bulk feed.
 *
 * Why this exists (BRO-4286): update-show-status.js's "wrongly-closed show"
 * self-heal reopened my-joy-is-heavy-off-broadway-2025 on 2026-09-06 because
 * TodayTix's bulk feed still listed its todaytixId+title 16 hours after we'd
 * correctly closed it. TodayTix kept a stale, unpurged "ghost listing" in its
 * catalog for ~15 days post-closing (closingDatetime:null, empty showtimes) —
 * presence alone is not proof of an active run.
 */

/**
 * @param {object} ttShow - a show object from TodayTix's /api/v2/shows feed
 * @param {Date} [now] - reference date for bookingEndDate comparisons (testability)
 * @returns {boolean} true if ttShow carries positive evidence of bookability
 */
function hasBookableEvidence(ttShow, now = new Date()) {
  if (!ttShow) return false;

  if (ttShow.areRegularTicketsAvailable === true) return true;

  // Check both arrays independently — `a || b` would pick a present-but-empty
  // filteredShowtimeMaps over a non-empty showtimes, silently discarding it.
  const showtimeArrays = [ttShow.filteredShowtimeMaps, ttShow.showtimes].filter(Array.isArray);
  if (showtimeArrays.some(arr => arr.length > 0)) return true;

  // Compare as 'YYYY-MM-DD' strings (TodayTix's native format) rather than
  // Date objects — parsing a date-only string as UTC then truncating with
  // local setHours() shifts the result a day in negative-UTC-offset zones.
  if (typeof ttShow.bookingEndDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ttShow.bookingEndDate)) {
    const todayStr = now.toISOString().slice(0, 10);
    if (ttShow.bookingEndDate.slice(0, 10) >= todayStr) return true;
  }

  return false;
}

module.exports = { hasBookableEvidence };
