/**
 * Housekeeping for the follow-notification digest (BRO-4897).
 *
 * detect-show-changes.js carries every pending `changes` entry forward and
 * send-follow-notifications.js only deletes shows it fully delivered. Until
 * BRO-4897 the digest was never committed, so none of this mattered; once it
 * persists, three things would otherwise send stale news:
 *   - a show nobody follows keeps its changes until a follower appears,
 *   - a followed show whose changes stay below the send threshold keeps them,
 *   - a digest whose baseline is weeks old re-detects everything since then.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Pending changes older than this are dropped, sent or not. */
const MAX_CHANGE_AGE_DAYS = 30;
/** A previous digest older than this is a stale baseline: re-baseline, send nothing. */
const STALE_BASELINE_DAYS = 21;

/** Show ids in `changes` that nobody follows. */
function unfollowedShowIds(changes, followersByShow) {
  const map = followersByShow || {};
  return Object.keys(changes || {}).filter((showId) => {
    const list = map[showId];
    return !Array.isArray(list) || list.length === 0;
  });
}

/** True when the previous digest is too old to diff against (or undated). */
function isStaleBaseline(prevGeneratedAt, now = Date.now()) {
  const t = Date.parse(prevGeneratedAt || '');
  if (Number.isNaN(t)) return true;
  return now - t > STALE_BASELINE_DAYS * DAY_MS;
}

/** Adds `detectedAt` to change entries that lack one (mutates and returns). */
function stampDetectedAt(changesByShow, nowIso = new Date().toISOString()) {
  for (const list of Object.values(changesByShow || {})) {
    for (const c of list) if (!c.detectedAt) c.detectedAt = nowIso;
  }
  return changesByShow;
}

/**
 * Removes entries older than `maxAgeDays` (undated entries count as old) and
 * shows left with none. Returns the number of entries removed. Mutates.
 */
function dropAgedChanges(changesByShow, now = Date.now(), maxAgeDays = MAX_CHANGE_AGE_DAYS) {
  let removed = 0;
  const cutoff = now - maxAgeDays * DAY_MS;
  for (const [showId, list] of Object.entries(changesByShow || {})) {
    const kept = list.filter((c) => {
      const t = Date.parse(c.detectedAt || '');
      return !Number.isNaN(t) && t >= cutoff;
    });
    removed += list.length - kept.length;
    if (kept.length) changesByShow[showId] = kept;
    else delete changesByShow[showId];
  }
  return removed;
}

module.exports = {
  unfollowedShowIds,
  isStaleBaseline,
  stampDetectedAt,
  dropAgedChanges,
  MAX_CHANGE_AGE_DAYS,
  STALE_BASELINE_DAYS,
};
