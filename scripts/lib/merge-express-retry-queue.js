// Array-of-entries merge for data/audit/express-retry-queue.json.
//
// Why this exists:
//   opening-night-express.yml gets its own per-show concurrency group
//   (`opening-night-express-${{ inputs.show_id }}`), so multiple shows
//   opening the same night run concurrently and can each append a retry
//   entry to this file around the same time. Without a real merge here, the
//   file falls to push-with-retry.sh's generic `data/audit/*` "keep local"
//   whole-file conflict resolution — the SECOND run's push would silently
//   discard the FIRST run's already-committed retry entry for a different
//   show, exactly the data-loss class already fixed for commercial.json,
//   diary-shows.json and awards.json (see their
//   merge-*.js siblings). Card #1889.
//
// Used by:
//   - scripts/lib/merge-commercial-conflict.js (push-with-retry.sh conflict path)
//   - scripts/lib/core-data-merge-registry.js (registers this file + fn)
//
// Merge rules:
//   * shape: { entries: [ { showId, market, queuedAt, dueAt, attempted,
//     attemptedAt? }, ... ] }
//   * Natural key: `${showId}|${queuedAt}` — a show can have more than one
//     historical entry (a later opening after an earlier attempted retry).
//   * Union of keys is kept: entries present on only one side survive.
//   * On key collision: attempted wins over un-attempted (never let a merge
//     "undispatch" an entry the other side already fired — that would risk
//     opening-night-express-retry-check.yml dispatching the same retry
//     twice). If both sides agree on attempted, keep OURS (matches the
//     "-X ours" rebase strategy already applied upstream).
//   * Order: ours first (original order preserved), then remote-only entries
//     appended in remote order — deterministic, minimal diff.
//   * BRO-4334: entries with a `kind` (truncated-t1-refetch) come in sets that
//     share showId+queuedAt (one per +1h/+3h/+12h offset), so their key also
//     carries kind and dueAt. Legacy (kind-less) keys are unchanged.
//   * BRO-5955: three-way when `base` (the common ancestor) is supplied. A
//     remote-only key absent from base is a concurrent ADD and is kept; a
//     key the base held that either side no longer has was DELETED there
//     (express-retry-queue.js pruneStale/writeQueueEntries) and stays gone.
//     Without a base every remote-only key is restored (the old two-way
//     union), which is right for "they added" and wrong for "we pruned".
//     Why: on 2026-10-22 The Pianist's Express push (81788096e4) rebased with
//     `-X theirs` on a clean hunk and replaced the Imaginary Invalid retry
//     entry queued minutes earlier (fa0b74587d). No conflict, so the case-arm
//     merge never ran; push-with-retry.sh now names this file in its
//     post-rebase reconcile call, which passes the true fork point as base.
function keyOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!entry.showId || !entry.queuedAt) return null;
  if (entry.kind) return `${entry.kind}|${entry.showId}|${entry.queuedAt}|${entry.dueAt || ''}`;
  return `${entry.showId}|${entry.queuedAt}`;
}

function pickOnCollision(oursEntry, remoteEntry) {
  if (remoteEntry.attempted && !oursEntry.attempted) return remoteEntry;
  return oursEntry;
}

function mergeExpressRetryQueue(ours, remote, base) {
  ours = ours && typeof ours === 'object' ? ours : { entries: [] };
  remote = remote && typeof remote === 'object' ? remote : { entries: [] };
  const oursEntries = Array.isArray(ours.entries) ? ours.entries : [];
  const remoteEntries = Array.isArray(remote.entries) ? remote.entries : [];
  const baseKeys = base && typeof base === 'object' && Array.isArray(base.entries)
    ? new Set(base.entries.map(keyOf).filter(Boolean))
    : null;
  const remoteKeys = new Set(remoteEntries.map(keyOf).filter(Boolean));

  const byKey = new Map();
  const mergedEntries = [];
  let remotePruned = 0;
  for (const e of oursEntries) {
    const k = keyOf(e);
    if (k && baseKeys && baseKeys.has(k) && !remoteKeys.has(k)) {
      // In base, gone from remote: the other side pruned or replaced it.
      remotePruned++;
      continue;
    }
    if (k) byKey.set(k, e);
    mergedEntries.push(e);
  }

  let added = 0;
  let kept = 0;
  let resolvedToRemoteAttempted = 0;
  let deletesHonored = 0;
  for (const e of remoteEntries) {
    const k = keyOf(e);
    if (!k) continue;
    const oursEntry = byKey.get(k);
    if (oursEntry) {
      const winner = pickOnCollision(oursEntry, e);
      if (winner !== oursEntry) {
        const idx = mergedEntries.indexOf(oursEntry);
        if (idx !== -1) mergedEntries[idx] = winner;
        resolvedToRemoteAttempted++;
      } else {
        kept++;
      }
      continue;
    }
    if (baseKeys && baseKeys.has(k)) {
      // In base, gone from ours: we pruned it; remote's copy is stale.
      deletesHonored++;
      continue;
    }
    mergedEntries.push(e);
    byKey.set(k, e);
    added++;
  }

  return {
    merged: { ...ours, entries: mergedEntries },
    stats: {
      added, kept, resolvedToRemoteAttempted, deletesHonored, remotePruned,
      baseAvailable: !!baseKeys, totalEntries: mergedEntries.length,
    },
  };
}
// The post-rebase reconcile must pass the real fork point: its fallback
// (`merge-base HEAD <ref>`) equals the remote after a rebase, which would read
// every concurrent add as our delete (BRO-4484).
mergeExpressRetryQueue.requiresTrueBase = true;

module.exports = { mergeExpressRetryQueue, keyOf };
