/**
 * showscore-closure-guard.js — when a ShowScore "Closed" must NOT close a show.
 *
 * A returning production reuses the ShowScore page (and often the stored
 * todaytixId) of its earlier run, so the page can read "Closed" while the new
 * run is about to open. Slam Frank (opens 2026-10-04, previews from 09-17) was
 * marked closed that way and sat hidden on opening night (BRO-4640).
 *
 * A show that opened (or opens) within the last NEW_RUN_WINDOW_DAYS cannot have
 * genuinely closed yet, so its ShowScore "Closed" is held until the window ends.
 */

const NEW_RUN_WINDOW_DAYS = 7;
const PREVIEWS_ONLY_WINDOW_DAYS = 14;

function daysBetween(fromStr, toStr) {
  return Math.floor((Date.parse(toStr) - Date.parse(fromStr)) / 86400000);
}

/** True when a ShowScore "Closed" should be ignored for this show. */
function isNewRunTooFreshToClose(show, todayStr) {
  if (show.openingDate) {
    return daysBetween(show.openingDate, todayStr) <= NEW_RUN_WINDOW_DAYS;
  }
  if (show.previewsStartDate) {
    return daysBetween(show.previewsStartDate, todayStr) <= PREVIEWS_ONLY_WINDOW_DAYS;
  }
  return false;
}

module.exports = { isNewRunTooFreshToClose, NEW_RUN_WINDOW_DAYS, PREVIEWS_ONLY_WINDOW_DAYS };
