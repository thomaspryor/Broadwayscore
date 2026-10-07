// Keyed-union merge for data/opening-night-sent.json (BRO-76).
//
// Why this exists: a send ledger — { shows: { [compositeKey]: { sentAt, ... } } }
// — with SIX independent writers/concurrency groups (reconcile-newsletter-state,
// broadcast-send, the opening-night orchestrator, per-show opening-night-poller-*,
// reconcile-broadcast-state, refresh-show-score-opening-night). It was one of the
// CORE_FILES with no reconciliation: a push race fell to `-X ours`, and the losing
// side's "we already sent this" record vanished — risking a duplicate send on the
// next run, the exact failure class this ledger exists to prevent.
//
// Merge rule: union by compositeKey. Originally each key was assumed written
// ONCE at send time, so a both-present conflict just kept `ours` — but
// reconcile-broadcast-state.js (task #1853) repeatedly mutates existing keys
// (draft→sending→sent transitions), so that assumption no longer holds. On a
// both-present conflict, `ours` still wins by default, UNLESS `remote`'s
// recorded content is strictly newer per recordRecencyMs (task #1914) — see
// scripts/lib/tracker-record-recency.js for the shared comparator and why
// lastReconciledAt (an observation stamp, not a content stamp) is excluded
// from it.

const { recordRecencyMs } = require('./tracker-record-recency');

function mergeOpeningNightSent(ours, remote) {
  ours = ours || { shows: {} };
  remote = remote || { shows: {} };
  const oursShows = ours.shows || {};
  const remoteShows = remote.shows || {};
  const merged = { ...ours };
  merged.shows = { ...oursShows };

  let added = 0, kept = 0, remoteNewer = 0;
  const allKeys = new Set([...Object.keys(oursShows), ...Object.keys(remoteShows)]);
  for (const key of allKeys) {
    const o = oursShows[key];
    const r = remoteShows[key];
    if (!o && r) { merged.shows[key] = r; added++; continue; }
    if (o && r && recordRecencyMs(r) > recordRecencyMs(o)) {
      merged.shows[key] = r;
      remoteNewer++;
      continue;
    }
    kept++; // o present and not older than r (or neither present)
  }

  return { merged, stats: { added, kept, remoteNewer, totalKeys: allKeys.size } };
}

module.exports = { mergeOpeningNightSent };
