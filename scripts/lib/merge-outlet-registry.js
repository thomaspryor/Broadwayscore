/**
 * Push-time merge for data/outlet-registry.json (BRO-4405).
 *
 * ~20 workflows run scripts/rebuild-all-reviews.js, whose AUTO-REGISTER block
 * rewrites this file, and .github/actions/push-core-data commits it. Two runs
 * registering different outlets from the same base used to conflict, and the
 * push path resolved hunk-wise (rebase -X theirs) so one side's new outlet
 * row was dropped until a later rebuild re-registered it.
 *
 * Document shape: { _meta, outlets: {id: entry}, _aliasIndex: {alias: id},
 * lastUpdated?, lastChange? }.
 *
 * Rules: union `outlets` by id; on a shared id OURS wins the whole entry
 * (humans edit entries through the normal rebase, the rebuild only adds),
 * unless a merge base is supplied and our entry is unchanged from it: then
 * ours is a stale copy (git-API fallback builds ours on an old base) and the
 * remote entry wins, so a remote tier/domain/region backfill is not undone.
 * `_aliasIndex` is unioned the same way (ours wins), so aliases of a
 * remote-only outlet survive. `_meta.lastUpdated` takes the later stamp;
 * `_meta` otherwise ours. Top-level lastUpdated/lastChange, and
 * _meta.lastChange when present, follow the document whose _meta.lastUpdated
 * is later.
 */
'use strict';

function asObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function ts(v) {
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

function sameEntry(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {object} ours  our parsed document
 * @param {object} remote  the remote tip's parsed document
 * @param {object} [base]  the merge base's parsed document, when the caller has one
 * @returns {{merged: object, stats: {added: number, kept: number, total: number}}}
 */
function mergeOutletRegistry(ours, remote, base) {
  const o = asObj(ours);
  const r = asObj(remote);
  const oursOutlets = asObj(o.outlets);
  const remoteOutlets = asObj(r.outlets);
  const outlets = { ...remoteOutlets, ...oursOutlets };
  if (base !== undefined && base !== null) {
    const baseOutlets = asObj(asObj(base).outlets);
    for (const id of Object.keys(oursOutlets)) {
      if (id in remoteOutlets && id in baseOutlets && sameEntry(oursOutlets[id], baseOutlets[id])) {
        outlets[id] = remoteOutlets[id];
      }
    }
  }
  const added = Object.keys(remoteOutlets).filter((id) => !(id in oursOutlets)).length;
  const kept = Object.keys(oursOutlets).filter((id) => id in remoteOutlets && sameEntry(outlets[id], oursOutlets[id])).length;
  const aliasIndex = { ...asObj(r._aliasIndex), ...asObj(o._aliasIndex) };
  if (base !== undefined && base !== null) {
    const baseAliases = asObj(asObj(base)._aliasIndex);
    const remoteAliases = asObj(r._aliasIndex);
    for (const [alias, id] of Object.entries(asObj(o._aliasIndex))) {
      if (alias in remoteAliases && alias in baseAliases && baseAliases[alias] === id) aliasIndex[alias] = remoteAliases[alias];
    }
  }

  const oursNewer = ts(asObj(o._meta).lastUpdated) >= ts(asObj(r._meta).lastUpdated);
  const newer = oursNewer ? o : r;
  const meta = { ...asObj(r._meta), ...asObj(o._meta) };
  const latestStamp = asObj(newer._meta).lastUpdated;
  if (latestStamp) meta.lastUpdated = latestStamp;
  if (asObj(newer._meta).lastChange !== undefined) meta.lastChange = newer._meta.lastChange;

  const merged = { ...r, ...o, _meta: meta, outlets, _aliasIndex: aliasIndex };
  for (const k of ['lastUpdated', 'lastChange']) {
    if (newer[k] !== undefined) merged[k] = newer[k];
  }
  return { merged, stats: { added, kept, total: Object.keys(outlets).length } };
}

module.exports = { mergeOutletRegistry };
