/**
 * opening-events-for-week.js — classify a single show's opening event for a
 * given newsletter week window.
 *
 * BRO-2594: the inline version in scripts/newsletter/generate.mjs checked
 * `inWeek(openingDate)` first and `continue`d on a match, so it never reached
 * the `inWeek(reopeningDate)` check — even when reopeningDate ALSO fell in
 * the same week. That only shows up when both dates land in the same window
 * (e.g. a backfilled/corrected openingDate coinciding with a real
 * reopeningDate), which is why it slipped past normal use. Checking
 * reopeningDate first fixes the precedence: a show with reopeningDate set has
 * already had its original opening, so if both match, the event actually
 * happening this week is the reopening.
 */

/**
 * @param show a shows.json entry (or null)
 * @param inWeekFn (dateStr) => boolean — the caller's week-window predicate
 * @returns {{isReopening: boolean}|null} null when neither date falls in the week
 */
function classifyOpeningEvent(show, inWeekFn) {
  if (!show) return null;
  if (inWeekFn(show.reopeningDate)) return { isReopening: true };
  if (inWeekFn(show.openingDate)) return { isReopening: false };
  return null;
}

module.exports = { classifyOpeningEvent };
