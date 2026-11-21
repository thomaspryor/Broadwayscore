// Poster-bookmark date label, ported from the iOS app (BroadwayScorecard-app
// lib/bookmark-date-label.ts, PR 21) so web and app print the same ribbon.
// CommonJS on purpose, like browse-sort.js: tsconfig allowJs lets .tsx import
// it and tests/unit/*.test.mjs require() the real functions (CLAUDE.md s15).
//
//   today / future -> "NOV 17"  (month and day, whatever the year)
//   past           -> "OCT '26" (month and year; the day no longer matters)
//
// `today` is a local YYYY-MM-DD (toLocalYMD below). Dates are split by hand,
// never parsed through Date: bare `new Date('YYYY-MM-DD')` is UTC midnight and
// flips a day early in US timezones.

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Local-time YYYY-MM-DD (not toISOString, which is UTC). */
function toLocalYMD(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** True when a planned date is before today: already seen, not yet rated. Malformed -> false. */
function isPastPlannedDate(planned, today) {
  if (!planned || !/^\d{4}-\d{2}-\d{2}/.test(planned)) return false;
  return planned.slice(0, 10) < today;
}

function formatBookmarkDate(planned, today) {
  if (!planned) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(planned);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const monthName = MONTHS[month - 1];
  return isPastPlannedDate(planned, today) ? `${monthName} '${m[1].slice(2)}` : `${monthName} ${day}`;
}

/** Screen-reader form: "OCT '26" would be read as October 26th. */
function spokenBookmarkDate(planned, today) {
  if (!formatBookmarkDate(planned, today) || !planned) return null;
  const month = MONTH_NAMES[Number(planned.slice(5, 7)) - 1];
  return isPastPlannedDate(planned, today) ? `${month} ${planned.slice(0, 4)}` : `${month} ${Number(planned.slice(8, 10))}`;
}

/** show_id -> planned_date for every watchlist entry that has one. */
function buildPlannedDateMap(watchlist) {
  const map = new Map();
  for (const w of watchlist) {
    if (w.planned_date) map.set(w.show_id, w.planned_date);
  }
  return map;
}

module.exports = { toLocalYMD, isPastPlannedDate, formatBookmarkDate, spokenBookmarkDate, buildPlannedDateMap };
