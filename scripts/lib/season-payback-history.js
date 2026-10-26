'use strict';

/**
 * History of each season's estimated payback (BRO-6335): one row per season
 * per day, {date, season, capital, returnedLow, returnedMid, returnedHigh,
 * shows, of}, appended by the daily commercial-stale-closures run so the
 * season page can show how a season's money back has grown. Pure; the CLI
 * is scripts/append-season-payback-history.ts.
 */

const HISTORY_FILE = 'season-payback-history.json';

/** Rows for one day from SeasonProfile objects (buildSeasonProfiles). Seasons with no capital estimate are skipped. */
function rowsFromProfiles(profiles, date) {
  const rows = [];
  for (const p of profiles) {
    const r = p && p.returnedCapital;
    if (!r || !(r.capital > 0) || !(r.shows > 0)) continue;
    rows.push({
      date,
      season: p.season,
      capital: Math.round(r.capital),
      returnedLow: Math.round(r.low),
      returnedMid: Math.round(r.mid),
      returnedHigh: Math.round(r.high),
      shows: r.shows,
      of: r.of,
    });
  }
  return rows;
}

/** History plus today's rows; a rerun on the same day replaces that day's row for the season. Sorted by date, then season. */
function appendRows(history, rows) {
  const list = Array.isArray(history) ? history : [];
  const key = (r) => `${r.date}|${r.season}`;
  const fresh = new Set(rows.map(key));
  return [...list.filter((r) => !fresh.has(key(r))), ...rows]
    .sort((a, b) => a.date.localeCompare(b.date) || a.season.localeCompare(b.season));
}

/** One season's rows, oldest first. */
function historyForSeason(history, season) {
  return (Array.isArray(history) ? history : []).filter((r) => r.season === season).sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { HISTORY_FILE, rowsFromProfiles, appendRows, historyForSeason };
