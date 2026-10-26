/**
 * Daily history of each season's estimated money back (BRO-6335).
 * One row per season per day: {date, season, capital, returnedLow,
 * returnedMid, returnedHigh}, all whole dollars. Rerunning a day replaces
 * that day's rows, so the daily step is idempotent. Pure: no I/O.
 */

/** @param {{season:string, returnedCapital:{capital:number,low:number,mid:number,high:number}}} profile */
function rowFor(date, profile) {
  const r = profile.returnedCapital;
  return {
    date,
    season: profile.season,
    capital: Math.round(r.capital),
    returnedLow: Math.round(r.low),
    returnedMid: Math.round(r.mid),
    returnedHigh: Math.round(r.high),
  };
}

/** History with `rows` for `date` swapped in, oldest first. Seasons not in `rows` keep their other days. */
function upsertRows(history, date, rows) {
  const seasons = new Set(rows.map((r) => r.season));
  const kept = (history?.rows ?? []).filter((r) => !(r.date === date && seasons.has(r.season)));
  const all = [...kept, ...rows].sort((a, b) => a.date.localeCompare(b.date) || a.season.localeCompare(b.season));
  return { version: 1, rows: all };
}

/** A season's rows, oldest first. */
function seasonRows(history, season) {
  return (history?.rows ?? []).filter((r) => r.season === season).sort((a, b) => a.date.localeCompare(b.date));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);

/**
 * How a season's money back moved: the newest row against the newest row
 * 28 or more days older, else the oldest row if it is at least 7 days older.
 * null until the history spans a week. `rows` is one season, oldest first.
 */
function trendFor(rows) {
  if (!rows || rows.length < 2) return null;
  const to = rows[rows.length - 1];
  const age = (r) => (dayMs(to.date) - dayMs(r.date)) / DAY_MS;
  const month = [...rows].reverse().find((r) => age(r) >= 28);
  const from = month ?? (age(rows[0]) >= 7 ? rows[0] : null);
  return from ? { from, to, change: to.returnedMid - from.returnedMid } : null;
}

module.exports = { rowFor, upsertRows, seasonRows, trendFor };
