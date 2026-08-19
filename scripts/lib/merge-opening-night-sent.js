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
// Merge rule: simple union by compositeKey. Each key is written once, at send
// time, by whichever workflow sent it — there is no meaningful "newer" version
// to pick, so on the (essentially never-expected) case both sides have the
// same key, keep ours.

function mergeOpeningNightSent(ours, remote) {
  ours = ours || { shows: {} };
  remote = remote || { shows: {} };
  const oursShows = ours.shows || {};
  const remoteShows = remote.shows || {};
  const merged = { ...ours };
  merged.shows = { ...oursShows };

  let added = 0, kept = 0;
  const allKeys = new Set([...Object.keys(oursShows), ...Object.keys(remoteShows)]);
  for (const key of allKeys) {
    const o = oursShows[key];
    const r = remoteShows[key];
    if (!o && r) { merged.shows[key] = r; added++; continue; }
    kept++; // o present (ours wins on the rare both-present case) or neither
  }

  return { merged, stats: { added, kept, totalKeys: allKeys.size } };
}

module.exports = { mergeOpeningNightSent };
