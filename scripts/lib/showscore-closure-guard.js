/**
 * showscore-closure-guard.js — when a ShowScore "Closed" must NOT close a show.
 *
 * A returning production reuses the ShowScore page (and often the stored
 * todaytixId) of its earlier run, so the page can read "Closed" while the new
 * run is about to open. Slam Frank (opens 2026-10-04, previews from 09-17) was
 * marked closed that way and sat hidden on opening night (BRO-4640).
 *
 * Two signals say the ShowScore "Closed" belongs to an earlier run:
 *  1. the run opened within NEW_RUN_WINDOW_DAYS (or opens within
 *     FUTURE_OPENING_WINDOW_DAYS), so it cannot have genuinely closed yet;
 *  2. the show's TodayTix ticket link names a different TodayTix id than the
 *     stored todaytixId, so the stored id (and the "TodayTix not active"
 *     check built on it) is the earlier run's.
 */

const NEW_RUN_WINDOW_DAYS = 7;
const PREVIEWS_ONLY_WINDOW_DAYS = 14;
const FUTURE_OPENING_WINDOW_DAYS = 30; // a longer-delayed opening is not held forever

function daysBetween(fromStr, toStr) {
  return Math.floor((Date.parse(toStr) - Date.parse(fromStr)) / 86400000);
}

/** The TodayTix show id named by the show's ticketLinks, or null. */
function ticketLinkTodayTixId(show) {
  for (const link of show.ticketLinks || []) {
    const m = /todaytix\.com\/[^/]+\/shows\/(\d+)/.exec(link && link.url || '');
    if (m) return m[1];
  }
  return null;
}

/** True when the stored todaytixId disagrees with the show's own TodayTix link. */
function hasStaleTodayTixId(show) {
  const linked = ticketLinkTodayTixId(show);
  return Boolean(linked && show.todaytixId && String(show.todaytixId) !== linked);
}

/** True when a ShowScore "Closed" should be ignored for this show. */
function isNewRunTooFreshToClose(show, todayStr) {
  if (hasStaleTodayTixId(show)) return true;
  if (show.openingDate) {
    const days = daysBetween(show.openingDate, todayStr);
    return days <= NEW_RUN_WINDOW_DAYS && days >= -FUTURE_OPENING_WINDOW_DAYS;
  }
  if (show.previewsStartDate) {
    return daysBetween(show.previewsStartDate, todayStr) <= PREVIEWS_ONLY_WINDOW_DAYS;
  }
  return false;
}

module.exports = {
  isNewRunTooFreshToClose,
  hasStaleTodayTixId,
  NEW_RUN_WINDOW_DAYS,
  PREVIEWS_ONLY_WINDOW_DAYS,
  FUTURE_OPENING_WINDOW_DAYS,
};
