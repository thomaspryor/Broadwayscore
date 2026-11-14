'use strict';

/**
 * Mode for the unattended national-tour writers (BRO-4262): enrich-tour-dates
 * (TOUR_DATES_MODE) and create-tour-entries (TOUR_AUTOCREATE).
 *
 * An explicit repo variable wins: off | report | write. Unset, they run
 * report-only for their first week, then write, so the switch-on needs no one
 * (the owner has no Vercel/GitHub settings access from a phone).
 */

const LIVE_FROM = '2026-10-06';

function tourAutomationMode(value, now = new Date()) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'off' || v === 'report' || v === 'write') return v;
  return now.toISOString().slice(0, 10) >= LIVE_FROM ? 'write' : 'report';
}

/**
 * Mode for creating STANDALONE tours (BRO-4931): touring shows with no tracked
 * production to descend from, found on Tours To You alone. A parented tour of
 * an Off-Broadway, regional or West End show follows TOUR_AUTOCREATE like a
 * Broadway one; a standalone one is new ground (the page's title and type are
 * the only anchor), so it is report-only until the owner has seen the first
 * results and sets TOUR_STANDALONE_AUTOCREATE=write. Unset is always report,
 * never date-switched. It is never louder than the main switch: with
 * TOUR_AUTOCREATE=off or report it is off or report too.
 */
const RANK = { off: 0, report: 1, write: 2 };
function standaloneTourMode(value, mainMode) {
  const v = String(value || '').trim().toLowerCase();
  const own = Object.prototype.hasOwnProperty.call(RANK, v) ? v : 'report';
  const main = Object.prototype.hasOwnProperty.call(RANK, mainMode) ? mainMode : 'report';
  return RANK[own] <= RANK[main] ? own : main;
}

module.exports = { tourAutomationMode, standaloneTourMode, LIVE_FROM };
