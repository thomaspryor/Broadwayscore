/**
 * lottery-rush.json "last successful check" stamp (BRO-901 / BRO-5261).
 *
 * `lastUpdated` only moves when a policy changed, so it cannot tell a healthy
 * feed with nothing new apart from a dead one. The site's data-stale banner
 * keys on `lastCheckedAt` instead (src/lib/data-staleness.ts), which
 * scrape-lottery-rush.js stamps on every full check, changes or not.
 */

const LOTTERY_RUSH_SOURCES = ['bwayrush', 'playbill', 'twopenny'];

/**
 * True when this run checked every source and each one answered with data,
 * so the file can be called current as of now. A --source partial run, or a
 * source that came back empty (blocked, parse failure), is not a full check.
 */
function isFullCheck(sourceFilter, answered) {
  if (sourceFilter) return false;
  return LOTTERY_RUSH_SOURCES.every((k) => answered && answered[k] === true);
}

/**
 * The file to write on a full check with no policy changes: the file exactly
 * as it was on disk plus the new lastCheckedAt. lastUpdated is left alone.
 */
function stampCheckOnly(snapshot, runAt) {
  return { ...snapshot, lastCheckedAt: runAt };
}

module.exports = { LOTTERY_RUSH_SOURCES, isFullCheck, stampCheckOnly };
