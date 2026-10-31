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
 * from) and opts.ours (our file before the rebase), a key or source in base but absent from ours was deliberately
 * removed by our side, so remote's copy is not refilled, whether or not the show
 * is live. Only keys/sources that are absent from base (added by a concurrent
 * writer) are recovered. Our deletion wins over a concurrent remote edit of the same
 * key or source. If more than max(5, 10% of keys) keys or max(25, 50% of keys) sources look
 * deleted (a truncated 'ours'), the rule is skipped for the run. Without opts.base the old live-id rule alone applies.
 *
 * @param {object} current  post-rebase audience-buzz.json (mutated)
 * @param {object} remote   origin/main audience-buzz.json before the rebase
 * @param {{liveIds?: Set<string>, retiredIds?: Set<string>, base?: object, ours?: object}} [opts]
 *   liveIds below the plausibility floor (or absent) = no orphan filtering
 * @returns {{recovered: number, skippedOrphans: string[], skippedDeleted: string[]}}
 */
function reconcileAudienceBuzz(current, remote, opts = {}) {
  const { filterToLiveShowIds } = require('./live-show-ids');
  const shows = current.shows || (current.shows = {});
  const remoteShows = (remote && remote.shows) || {};
  const baseShows = (opts.base && opts.base.shows) || null;
  // "Ours" is the job's own file (captured before any rebase), because `-X ours`
  // resolves a conflicting hunk to remote and can bring a deleted source back into
  // `current` before this runs. Without opts.ours, current stands in for it.
  const oursShows = (opts.ours && opts.ours.shows) || shows;
  const skippedDeleted = [];
  const deletedKeys = new Set();
  const deletedSrcs = new Set();
  const deletedSrcPairs = [];
  if (baseShows) {
    for (const [id, b] of Object.entries(baseShows)) {
      if (!oursShows[id]) { deletedKeys.add(id); continue; }
      const ourSrc = oursShows[id].sources || {};
      for (const [src, d] of Object.entries((b && b.sources) || {})) {
        if (d && d.score != null && !ourSrc[src]) { deletedSrcs.add(id + '\u0000' + src); deletedSrcPairs.push([id, src]); }
      }
    }
  }
  // Plausibility floor: a truncated or empty "ours" looks like a mass delete. Past the floor
  // the 3-way rule is dropped for this run (old live-id behaviour) rather than pushing it.
  const baseCount = baseShows ? Object.keys(baseShows).length : 0;
  if (deletedKeys.size > Math.max(5, baseCount * 0.1) || deletedSrcs.size > Math.max(25, baseCount * 0.5)) {
    deletedKeys.clear(); deletedSrcs.clear(); deletedSrcPairs.length = 0;
    skippedDeleted.push('IMPLAUSIBLE-MASS-DELETE: 3-way rule skipped');
  }
  // Re-apply our deletions that the rebase reverted.
  for (const id of deletedKeys) if (shows[id] && remoteShows[id]) { delete shows[id]; skippedDeleted.push(id); }
  for (const [id, src] of deletedSrcPairs) {
    if (shows[id] && shows[id].sources && shows[id].sources[src]) { delete shows[id].sources[src]; skippedDeleted.push(id + '/' + src); }
  }
  const remoteOnly = Object.keys(remoteShows).filter(id => {
    if (shows[id]) return false;
    if (deletedKeys.has(id)) { if (!skippedDeleted.includes(id)) skippedDeleted.push(id); return false; }
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
    const ourSrc = shows[id].sources || {};
    const remoteSrc = (entry && entry.sources) || {};
    // BRO-5276: a source our side removed on purpose (sourcesRemoved tombstone) is not refilled.
    const removed = shows[id].sourcesRemoved || {};
    for (const [src, data] of Object.entries(remoteSrc)) {
      if (removed[src]) continue;
      if (deletedSrcs.has(id + '\u0000' + src)) {
        if (!skippedDeleted.includes(id + '/' + src)) skippedDeleted.push(id + '/' + src);
        continue;
      }
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
