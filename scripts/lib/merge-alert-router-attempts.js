'use strict';

// JSONL append-only merge for data/audit/alert-router-attempts.jsonl (BRO-2413).
//
// Same rationale as merge-alert-ledger.js: 3 independent writers (see core-
// data-merge-registry.js's "NOT added, deliberately" comment), deliberately
// excluded from apiFallbackSafe and from push-via-git-api.sh's fast path -
// this merge is what makes that path safe instead of a bypass.
//
// Merge rules:
//   * shape: one JSON object per line - { ts, conditionKey, title, ok, error }.
//   * Pure append-only log, no natural "latest wins" semantics (unlike the
//     ledger/queue above, a later attempt does not supersede an earlier
//     one - both are real, distinct events). Union both sides' lines,
//     deduped by (ts, conditionKey) - an exact-timestamp collision on the
//     same condition is the only case two independent writers could produce
//     an indistinguishable duplicate for, and dropping the duplicate (not
//     unioning it) is correct there since it is the SAME event observed
//     twice, not two events.
//   * Retention (BRO-2413 round-2, Codex adversarial ship-check P1 finding):
//     the writer prunes entries older than ATTEMPTS_LOG_RETENTION_DAYS
//     (owner-alert-router.js) - a naive 2-way union resurrects every pruned
//     record from remote's stale unpruned copy on every merge, defeating
//     retention entirely (the file never actually shrinks). When a `base`
//     snapshot is supplied, a remote-only line ALSO present in base is
//     treated as a local prune and NOT restored - same base-aware-delete
//     pattern as merge-alert-ledger.js/merge-alert-digest-queue.js. `base`
//     is optional (two-way callers keep prior behavior - every remote-only
//     line is restored).
//   * Order: ours first (original order preserved), then remote-only lines
//     appended in remote order - deterministic, minimal diff, matches
//     merge-feedback-ledger.js's convention.

function keyOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return `${entry.ts || ''} ${entry.conditionKey || ''}`;
}

function mergeAlertRouterAttempts(local, remote, base) {
  const localEntries = Array.isArray(local) ? local : [];
  const remoteEntries = Array.isArray(remote) ? remote : [];
  const baseKeys = Array.isArray(base) ? new Set(base.map(keyOf)) : null;

  const localKeys = new Set(localEntries.map(keyOf));
  let deletesHonored = 0;
  const remoteOnly = remoteEntries.filter((e) => {
    if (localKeys.has(keyOf(e))) return false;
    if (baseKeys && baseKeys.has(keyOf(e))) {
      // Present in base, present on remote, absent locally: WE pruned it -
      // do not let remote's stale unpruned copy resurrect it.
      deletesHonored++;
      return false;
    }
    return true;
  });

  return {
    merged: [...localEntries, ...remoteOnly],
    stats: {
      local: localEntries.length,
      remote: remoteEntries.length,
      merged: localEntries.length + remoteOnly.length,
      remoteOnly: remoteOnly.length,
      deletesHonored,
    },
  };
}

module.exports = { mergeAlertRouterAttempts };
