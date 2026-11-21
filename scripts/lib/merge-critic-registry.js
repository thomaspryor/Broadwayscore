// Pick-newer-whole-file merge for data/critic-registry.json (BRO-76).
//
// Why this exists: unlike the other registry entries, critic-registry.json is
// NOT an incrementally-accumulated file — scripts/audit-critic-outlets.js
// fully REGENERATES it from reviews.json on every run, called from 3
// independently-scheduled/grouped workflows (rebuild-reviews,
// rebuild-fast-${run_id}, opening-night-poller-*). A union merge would be
// wrong here (there is nothing to union — both sides are complete snapshots
// derived from whatever reviews.json looked like at generation time); the
// correct reconciliation is simply "keep whichever snapshot was generated
// more recently," same as this repo already does for shows.json/
// commercial.json's `_meta.lastUpdated` tie-breaks, just applied to the
// WHOLE file instead of per-entry.

function mergeCriticRegistry(ours, remote) {
  ours = ours || { critics: {} };
  remote = remote || { critics: {} };
  const oursT = Date.parse(ours._meta?.lastUpdated || 0) || 0;
  const remoteT = Date.parse(remote._meta?.lastUpdated || 0) || 0;

  if (remoteT > oursT) {
    return { merged: remote, stats: { chose: 'remote', oursLastUpdated: ours._meta?.lastUpdated || null, remoteLastUpdated: remote._meta?.lastUpdated || null } };
  }
  return { merged: ours, stats: { chose: 'ours', oursLastUpdated: ours._meta?.lastUpdated || null, remoteLastUpdated: remote._meta?.lastUpdated || null } };
}

module.exports = { mergeCriticRegistry };
