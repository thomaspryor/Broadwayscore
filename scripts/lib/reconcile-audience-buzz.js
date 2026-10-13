'use strict';

/**
 * Post-rebase audience-buzz.json reconcile for .github/actions/push-core-data
 * (moved out of the action's inline node -e, BRO-3248).
 *
 * An `-X ours` rebase can drop another writer's work, so entries remote has
 * and we lack are copied back, and sources we lack are filled from remote.
 * Except: a key whose id is not a live show (liveIds) or is retired
 * (retiredIds) is NOT copied back. Before this, every deliberate deletion of
 * an orphan key was resurrected on the next push, which is why the orphan
 * count only ever grew (34 -> 100 keys across audience-buzz/show-score).
 *
 * @param {object} current  post-rebase audience-buzz.json (mutated)
 * @param {object} remote   origin/main audience-buzz.json before the rebase
 * @param {{liveIds?: Set<string>, retiredIds?: Set<string>}} [opts]
 *   liveIds below the plausibility floor (or absent) = no orphan filtering
 * @returns {{recovered: number, skippedOrphans: string[]}}
 */
function reconcileAudienceBuzz(current, remote, opts = {}) {
  const { filterToLiveShowIds } = require('./live-show-ids');
  const shows = current.shows || (current.shows = {});
  const remoteShows = (remote && remote.shows) || {};
  const remoteOnly = Object.keys(remoteShows).filter(id => !shows[id]);
  const remoteOnlySet = new Set(remoteOnly);
  const { kept, dropped } = filterToLiveShowIds(remoteOnly, opts.liveIds, { retiredIds: opts.retiredIds });
  let recovered = 0;
  for (const id of kept) {
    shows[id] = remoteShows[id];
    recovered++;
  }
  for (const [id, entry] of Object.entries(remoteShows)) {
    if (remoteOnlySet.has(id)) continue;
    const ourSrc = shows[id].sources || {};
    const remoteSrc = (entry && entry.sources) || {};
    for (const [src, data] of Object.entries(remoteSrc)) {
      if (data && data.score != null && (!ourSrc[src] || ourSrc[src].score == null)) {
        ourSrc[src] = data;
        recovered++;
      }
    }
    shows[id].sources = ourSrc;
  }
  return { recovered, skippedOrphans: dropped };
}

module.exports = { reconcileAudienceBuzz };
