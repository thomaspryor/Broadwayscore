'use strict';

// Append-only-ledger merge for data/audit/cross-show-url-holds.jsonl (BRO-6910).
// Parallel gather shards and opening-night pollers append to the same ledger;
// the post-rebase reconcile pass (PUSH_RECONCILE_MERGED_JSON=1) unions rows by
// (showId, url) so a losing run's drops are not silently lost. Kept separate
// from cross-show-url-ledger.js so core-data-merge-registry stays write-free.

// Merge key is (showId, url), the same as the append dedupe: two parallel
// gather runs that both dropped one URL keep a single row (ours wins).
function keyOf(e) {
  if (!e || typeof e !== 'object' || !e.showId || !e.url) return null;
  return `${e.showId}|${e.url}`;
}

// Union merge for concurrent appenders (same contract as mergeBwwRoundupLedger).
function mergeCrossShowUrlLedger(oursEntries, remoteEntries) {
  const ours = Array.isArray(oursEntries) ? oursEntries : [];
  const remote = Array.isArray(remoteEntries) ? remoteEntries : [];
  const seen = new Set();
  for (const e of ours) { const k = keyOf(e); if (k) seen.add(k); }
  const merged = [...ours];
  let added = 0;
  let kept = 0;
  for (const e of remote) {
    const k = keyOf(e);
    if (k && seen.has(k)) { kept++; continue; }
    merged.push(e);
    if (k) seen.add(k);
    added++;
  }
  return { merged, stats: { added, kept, total: merged.length } };
}

module.exports = { mergeCrossShowUrlLedger, keyOf };
