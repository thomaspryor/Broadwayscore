'use strict';

/**
 * theatr-stale-attachment.js (BRO-5276)
 *
 * Theatr (theatr-app.com) lists current and recent productions only. Its matcher
 * (scrape-theatr-audience.js matchTheatrToShows) joins by normalized title, so a
 * modern same-titled listing (tour, Encores!, regional, Off-Broadway revival)
 * lands on the one historical Broadway row that shares the title. 64 of the 67
 * closed-long-ago rows carrying Theatr votes on 2026-10-13 had closed before
 * 2021, i.e. before the app had users. Those scores describe a different
 * production and feed the live audience score.
 *
 * A show closed before THEATR_FIRST_YEAR cannot have genuine Theatr votes.
 * Pure helper shared by the scraper (refuse to attach), the contamination audit
 * (flag) and neutralize-stale-theatr-buzz.js (clean existing rows).
 */

const THEATR_FIRST_YEAR = 2021;

/**
 * @param {{status?: string, closingDate?: string|null}|null|undefined} show shows.json row
 * @returns {boolean} true when the show closed before Theatr existed
 */
function closedBeforeTheatr(show) {
  if (!show || show.status !== 'closed' || !show.closingDate) return false;
  const year = parseInt(String(show.closingDate).slice(0, 4), 10);
  return Number.isFinite(year) && year < THEATR_FIRST_YEAR;
}

module.exports = { THEATR_FIRST_YEAR, closedBeforeTheatr };
