/**
 * Pure show-change diffs, shared by scripts/detect-show-changes.js (follower
 * emails) and scripts/write-show-events.js (iOS closing alerts, BRO-6219).
 * No I/O: every function takes plain values and returns plain values.
 */

const { isBroadwayCategory, isOffBroadwayCategory } = require('./venue-classification');

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How a closing date changed between two snapshots.
 * @param {string|null|undefined} prev
 * @param {string|null|undefined} curr
 * @returns {'closing-announced'|'closing-extended'|'closing-shortened'|null}
 *   null when nothing changed, or the date was removed (nothing to announce).
 */
function diffClosingDate(prev, curr) {
  if (prev === curr) return null;
  if (!prev && curr) return 'closing-announced';
  if (prev && curr) {
    const prevDate = new Date(prev);
    const currDate = new Date(curr);
    if (currDate > prevDate) return 'closing-extended';
    if (currDate < prevDate) return 'closing-shortened';
  }
  return null;
}

/** New York shows only for v1: London closing dates are often booking tranches (olt-enrichment.js). */
function isNycCategory(category) {
  const show = { category };
  return isBroadwayCategory(show) || isOffBroadwayCategory(show);
}

// A feed with fewer shows than this is a bad checkout, not a quiet day (~2,600 today).
const MIN_SHOWS = 1000;
// More than this many genuinely new closing dates in one run is a data glitch
// (a baseline wipe, a bulk re-import), not news. They are recorded silently.
const MAX_NEW_EVENTS = 15;

/**
 * Which show_events rows a run should write. The table's unique key
 * (show_id, type, value) is the diff, so there is no baseline file to go stale:
 *
 *   - a date already recorded for the show is never recorded again
 *   - a show with no events yet and a date  -> closing-announced
 *   - a show with earlier events and a new date -> closing-moved
 *   - the very first run (table empty) records everything as `seeded`, so the
 *     dates that existed when this shipped never read as news
 *   - a run that would announce more than MAX_NEW_EVENTS dates records them
 *     all as seeded and reports `capped` for a human to look at
 *
 * @param {{shows: Array<{id:string,status?:string,category?:string,closingDate?:string|null}>,
 *          existing: Array<{show_id:string,type:string,value:string}>,
 *          maxNew?: number}} input
 */
function planShowEvents({ shows, existing, maxNew = MAX_NEW_EVENTS }) {
  if (!Array.isArray(shows) || shows.length < MIN_SHOWS) {
    return { abort: `only ${Array.isArray(shows) ? shows.length : 0} shows in the feed (minimum ${MIN_SHOWS})`, events: [], capped: false, seededRun: false };
  }
  const firstRun = existing.length === 0;
  const byShow = new Map();
  for (const e of existing) {
    const set = byShow.get(e.show_id) || new Set();
    set.add(e.value);
    byShow.set(e.show_id, set);
  }

  const fresh = [];
  for (const s of shows) {
    if (!s || !s.id || !s.closingDate || !YMD.test(s.closingDate)) continue;
    if (s.status === 'closed' || !isNycCategory(s.category)) continue;
    const known = byShow.get(s.id);
    if (known && known.has(s.closingDate)) continue;
    fresh.push({
      show_id: s.id,
      type: known && known.size > 0 ? 'closing-moved' : 'closing-announced',
      value: s.closingDate,
    });
  }

  const capped = !firstRun && fresh.length > maxNew;
  const seeded = firstRun || capped;
  return {
    abort: null,
    events: fresh.map(e => ({ ...e, seeded })),
    capped,
    seededRun: firstRun,
  };
}

module.exports = { diffClosingDate, isNycCategory, planShowEvents, MIN_SHOWS, MAX_NEW_EVENTS };
