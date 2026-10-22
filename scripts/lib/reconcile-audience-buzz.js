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
 * 3-way rule (BRO-5337): with opts.base (the checkout snapshot both sides started
 * from), a key or source present in base but absent from current was deliberately
 * removed by our side, so remote's copy is not refilled, whether or not the show
 * is live. Only keys/sources that are absent from base (added by a concurrent
 * writer) are recovered. Without opts.base the old live-id rule alone applies.
 *
 * @param {object} current  post-rebase audience-buzz.json (mutated)
 * @param {object} remote   origin/main audience-buzz.json before the rebase
 * @param {{liveIds?: Set<string>, retiredIds?: Set<string>, base?: object}} [opts]
 *   liveIds below the plausibility floor (or absent) = no orphan filtering
 * @returns {{recovered: number, skippedOrphans: string[], skippedDeleted: string[]}}
 */
function reconcileAudienceBuzz(current, remote, opts = {}) {
  const { filterToLiveShowIds } = require('./live-show-ids');
  const shows = current.shows || (current.shows = {});
  const remoteShows = (remote && remote.shows) || {};
  const baseShows = (opts.base && opts.base.shows) || null;
  const skippedDeleted = [];
  const remoteOnly = Object.keys(remoteShows).filter(id => {
    if (shows[id]) return false;
    if (baseShows && baseShows[id]) { skippedDeleted.push(id); return false; }
    return true;
  });
  const remoteOnlySet = new Set(remoteOnly);
  const { kept, dropped } = filterToLiveShowIds(remoteOnly, opts.liveIds, { retiredIds: opts.retiredIds });
  let recovered = 0;
  for (const id of kept) {
    shows[id] = remoteShows[id];
    recovered++;
  }
  for (const [id, entry] of Object.entries(remoteShows)) {
    if (remoteOnlySet.has(id) || !shows[id]) continue;
    const baseSrc = (baseShows && baseShows[id] && baseShows[id].sources) || {};
    const ourSrc = shows[id].sources || {};
    const remoteSrc = (entry && entry.sources) || {};
    // BRO-5276: a source our side removed on purpose (sourcesRemoved tombstone) is not refilled.
    // Without this a deleted source came straight back on the next push (108 Theatr rows did).
    const removed = shows[id].sourcesRemoved || {};
    for (const [src, data] of Object.entries(remoteSrc)) {
      if (removed[src]) continue;
      if (baseSrc[src] && baseSrc[src].score != null && !ourSrc[src]) { skippedDeleted.push(id + '/' + src); continue; }
      if (data && data.score != null && (!ourSrc[src] || ourSrc[src].score == null)) {
        ourSrc[src] = data;
        recovered++;
      }
    }
    shows[id].sources = ourSrc;
  }
  return { recovered, skippedOrphans: dropped, skippedDeleted };
}

/**
 * Remove a source from a show record AND leave the tombstone the reconcile above honours.
 * A bare `delete show.sources[src]` is silently undone by the next push-core-data rebase
 * (the reconcile refills any source our side lacks from remote). BRO-5276.
 * @param {object} show audience-buzz show record (mutated)
 * @param {string} src source key
 * @param {string} reason why it was removed
 */
function removeSourceWithTombstone(show, src, reason) {
  if (show.sources) delete show.sources[src];
  show.sourcesRemoved = { ...(show.sourcesRemoved || {}), [src]: reason };
}

module.exports = { reconcileAudienceBuzz, removeSourceWithTombstone };
