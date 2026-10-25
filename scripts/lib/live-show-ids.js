'use strict';

/**
 * Keep only ids that are live shows.json rows (BRO-3248).
 *
 * Writers that rebuild or reconcile an id-keyed file from something other
 * than shows.json (archive filenames, a URL map, a remote copy) otherwise
 * keep re-creating keys for renamed or retired shows: the orphans that
 * scripts/audit-orphan-show-ids.js reports. Same MIN_PLAUSIBLE_SHOWS floor as
 * that audit: a stub or truncated shows.json is never treated as the truth,
 * so below it nothing is filtered.
 */

const MIN_PLAUSIBLE_SHOWS = 100;

/**
 * @param {Iterable<string>} ids
 * @param {Set<string>} liveIds    ids present in shows.json
 * @param {{retiredIds?: Set<string>}} [opts]  ids that must never come back
 * @returns {{kept: string[], dropped: string[], filtered: boolean}}
 *   filtered=false when liveIds is below the floor (all ids kept, retired
 *   ids still dropped)
 */
function filterToLiveShowIds(ids, liveIds, opts = {}) {
  const retired = opts.retiredIds || new Set();
  const filtered = !!liveIds && liveIds.size >= MIN_PLAUSIBLE_SHOWS;
  const kept = [];
  const dropped = [];
  for (const id of ids) {
    // A retired id stays dropped even when a stale copy of shows.json (e.g. the
    // remote side of a push race) still lists it.
    if (retired.has(id)) dropped.push(id);
    else if (filtered && !liveIds.has(id)) dropped.push(id);
    else kept.push(id);
  }
  return { kept, dropped, filtered };
}

/**
 * shows.json ids as a Set, or null when the file is missing or unreadable
 * (filterToLiveShowIds then keeps everything). For archive-driven review
 * writers that map a file name to a show folder (BRO-5288).
 * @param {string} [showsPath]
 * @returns {Set<string>|null}
 */
function loadLiveShowIds(showsPath = require('path').join(__dirname, '../../data/shows.json')) {
  try {
    return new Set(JSON.parse(require('fs').readFileSync(showsPath, 'utf8')).shows.map(s => s.id));
  } catch {
    return null;
  }
}

/**
 * liveIds when it clears the floor, else null. For readers that filter
 * carried-forward per-show rows (BRO-5349: the review-gap audit keeps a row
 * for a retired id for ~395 days) and must skip the filter, not treat every
 * row as retired, when shows.json is a stub.
 * @param {Set<string>|null} liveIds
 * @returns {Set<string>|null}
 */
function plausibleLiveShowIds(liveIds) {
  return liveIds && liveIds.size >= MIN_PLAUSIBLE_SHOWS ? liveIds : null;
}

module.exports = { filterToLiveShowIds, loadLiveShowIds, plausibleLiveShowIds, MIN_PLAUSIBLE_SHOWS };
