'use strict';
/**
 * gap-recovery-opening-window.js (BRO-7389): which shows get NYT subscriber
 * text recovery during their opening window, instead of waiting for the
 * 01:30 nightly.
 *
 * Why: the first pass (CI: ScrapingBee / Browserbase, no subscriber session)
 * gets only page one of an NYT review (the-charioteer-off-broadway-2026:
 * 2,479 chars, tier truncated) or a multi-show child section below the floor
 * (the-unbelievers-off-broadway-2026: 2,399 chars; the-verge-off-broadway-2026:
 * 1,627 chars). The whole text comes only from the subscriber-browser route
 * (gap-recovery-driver, Mac launchd), which ran once a night, so each opening's
 * NYT review was fixed hours to two days after press night, by hand or by the
 * nightly. The opening-window job runs that same driver for nytimes only,
 * every 20 minutes, for shows whose opening is within WINDOW_DAYS.
 */

const DAY_MS = 86400000;
const WINDOW_DAYS = 4; // press night plus the stragglers; matches opening-grade's window shape

const MARKETS = new Set(['broadway', 'off-broadway', 'west-end', 'off-west-end']);

/** Shows whose opening night is within the last `days` (and not in the future by more than 1 day). */
function selectOpeningWindowShows(shows, { nowMs = Date.now(), days = WINDOW_DAYS } = {}) {
  const lo = nowMs - days * DAY_MS;
  const hi = nowMs + DAY_MS;
  return (shows || []).filter((s) => {
    if (!s || !s.id || !MARKETS.has(s.category)) return false;
    if (/^cancel/i.test(String(s.status || ''))) return false;
    if (typeof s.openingDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.openingDate)) return false;
    const t = Date.parse(`${s.openingDate}T23:59:59Z`);
    return t >= lo && t <= hi;
  }).map((s) => s.id);
}

/** argv for one driver run: nytimes only, live, this show. */
function driverArgsFor(showId) {
  return [`--show=${showId}`, '--outlet=nytimes', '--recent-only'];
}

module.exports = { selectOpeningWindowShows, driverArgsFor, WINDOW_DAYS };
