'use strict';

/**
 * orphan-cast-files.js (BRO-5277)
 *
 * data/cast/<showId>.json files whose show is no longer in shows.json (a row
 * retired or renamed after the cast backfill ran). 15 existed on 2026-10-13;
 * two held another production's cast (the-music-man / spamalot "off-broadway"
 * files carrying the national tour cast). Nothing cleaned them up, so the
 * cast audit kept warning SHOW_NOT_IN_DB.
 *
 * Pure planner so the prune script and its tests share one decision. Refuses
 * to prune when shows.json looks like a stub (cloud bootstrap fallback) or when
 * the orphan share is implausibly large, so a bad shows.json can never wipe
 * data/cast.
 */

const MIN_SHOWS_FOR_PRUNE = 500;
const MAX_ORPHAN_SHARE = 0.05;

/**
 * @param {string[]} castFileIds  ids from data/cast/*.json filenames
 * @param {Iterable<string>} showIds ids from shows.json
 * @returns {{prune: string[], refused: string|null}}
 */
function planOrphanCastPrune(castFileIds, showIds) {
  const known = new Set(showIds);
  if (known.size < MIN_SHOWS_FOR_PRUNE) {
    return { prune: [], refused: `shows.json has only ${known.size} ids (< ${MIN_SHOWS_FOR_PRUNE}); looks like a stub` };
  }
  const prune = castFileIds.filter((id) => !known.has(id)).sort();
  if (castFileIds.length && prune.length / castFileIds.length > MAX_ORPHAN_SHARE) {
    return { prune: [], refused: `${prune.length}/${castFileIds.length} cast files would be pruned (> ${MAX_ORPHAN_SHARE * 100}%)` };
  }
  return { prune, refused: null };
}

module.exports = { planOrphanCastPrune, MIN_SHOWS_FOR_PRUNE, MAX_ORPHAN_SHARE };
