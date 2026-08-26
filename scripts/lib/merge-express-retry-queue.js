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
//   diary-shows.json, awards.json, and social-post-history.json (see their
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
function keyOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!entry.showId || !entry.queuedAt) return null;
  return `${entry.showId}|${entry.queuedAt}`;
}

function pickOnCollision(oursEntry, remoteEntry) {
  if (remoteEntry.attempted && !oursEntry.attempted) return remoteEntry;
  return oursEntry;
}

function mergeExpressRetryQueue(ours, remote) {
  ours = ours && typeof ours === 'object' ? ours : { entries: [] };
  remote = remote && typeof remote === 'object' ? remote : { entries: [] };
  const oursEntries = Array.isArray(ours.entries) ? ours.entries : [];
  const remoteEntries = Array.isArray(remote.entries) ? remote.entries : [];

  const byKey = new Map();
  for (const e of oursEntries) {
    const k = keyOf(e);
    if (k) byKey.set(k, e);
  }

  const mergedEntries = [...oursEntries];
  let added = 0;
  let kept = 0;
  let resolvedToRemoteAttempted = 0;
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
    mergedEntries.push(e);
    byKey.set(k, e);
    added++;
  }

  return {
    merged: { ...ours, entries: mergedEntries },
    stats: { added, kept, resolvedToRemoteAttempted, totalEntries: mergedEntries.length },
  };
}

module.exports = { mergeExpressRetryQueue, keyOf };
