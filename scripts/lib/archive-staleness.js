'use strict';
// BRO-7931 #1: an aggregator archive fetched before (opening + 7d) holds a
// pre-review snapshot. The old "skip if file exists" rule never refreshed it.
const DAY = 86400000;
const REFRESH_AFTER_OPENING_DAYS = 7;
const RECENT_WINDOW_DAYS = 730; // owner rule: no gaps in the last 2 years

function parseFetchedDate(head) {
  // Two header styles exist: "Fetched: YYYY-MM-DD" (fetch-aggregator-pages.ts)
  // and "  Archived: <ISO>" (gather/download scripts). Most archives use the latter.
  const m = /^\s*(?:Fetched|Archived):\s*(\d{4}-\d{2}-\d{2})/m.exec(String(head || ''));
  return m ? m[1] : null;
}

// True when the archive was captured before the post-opening window closed
// AND that window has now closed (so a refetch would capture real reviews).
function isStalePreOpeningArchive({ fetched, openingDate, now = new Date() }) {
  if (!fetched || !openingDate) return false;
  const open = Date.parse(openingDate);
  const got = Date.parse(fetched);
  if (Number.isNaN(open) || Number.isNaN(got)) return false;
  const cutoff = open + REFRESH_AFTER_OPENING_DAYS * DAY;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (nowMs < cutoff) return false;           // window not closed yet
  if (nowMs - open > RECENT_WINDOW_DAYS * DAY) return false; // old show, leave alone
  return got < cutoff;
}

module.exports = { parseFetchedDate, isStalePreOpeningArchive, REFRESH_AFTER_OPENING_DAYS, RECENT_WINDOW_DAYS };
