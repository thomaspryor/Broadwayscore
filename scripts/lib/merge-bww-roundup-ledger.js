// Append-only-ledger merge for data/audit/bww-roundup-miss-ledger.jsonl.
//
// Why this exists (task #698):
//   opening-night-poller.yml can run concurrently for different shows
//   (concurrency group is per-show_id, not per-workflow — see the group
//   comment at the top of that file). Every run's "Commit poller backoff
//   state" step appends misses to this shared JSONL ledger and pushes via
//   push-with-retry.sh. `git rebase -X theirs` resolves a conflicting hunk in
//   favour of the replayed local commit WITHOUT ever reporting a conflict
//   (same #420 class as commercial-pending-review.json et al.), so the
//   losing run's appended line(s) can be silently dropped instead of unioned.
//
// Used by:
//   - scripts/lib/reconcile-merged-json.js (post-rebase reconcile pass,
//     opt-in via PUSH_RECONCILE_MERGED_JSON=1 on the poller's commit step)
//   - tests/unit/merge-bww-roundup-ledger.test.mjs
//
// Merge rules:
//   * Shape: array of {ts, showId} entries (one per JSONL line — see
//     recordRoundupMiss/readRoundupMisses in bww-roundup-persistence.js).
//   * Natural key: `${ts}|${showId}` — a real duplicate write (e.g. the
//     ledger read back as both "ours" and "remote" after an amend) collapses
//     to one line; two GENUINE misses on the same show at different
//     timestamps are NOT duplicates and both survive.
//   * Union of keys is kept: entries present on only one side survive. This
//     is the whole point — a concurrent run's miss for a DIFFERENT show must
//     never be dropped just because it landed in the same rebase window.
//   * Keyless entries (missing ts or showId, e.g. a hand-edited line) are
//     kept verbatim from ours but can't be deduped against remote; they pass
//     through unchanged, matching mergeDiaryShows' safe never-drop behaviour.
//     A genuinely CORRUPT line (unparsable JSON) never reaches this function
//     at all — reconcile-merged-json.js's parseJsonlLines() throws on those,
//     which skips reconciliation for the whole file rather than silently
//     dropping the line and committing that deletion.
//   * Order: ours first (original append order preserved), then
//     remote-only entries appended in remote order — deterministic, minimal
//     diff, and keeps isInRoundupMissCooldown's "most recent miss" scan
//     (lastMissForShow) correct regardless of order since it compares `ts`
//     values directly rather than assuming array order.

function keyOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!entry.ts || !entry.showId) return null;
  return `${entry.ts}|${entry.showId}`;
}

function mergeBwwRoundupLedger(oursEntries, remoteEntries) {
  const ours = Array.isArray(oursEntries) ? oursEntries : [];
  const remote = Array.isArray(remoteEntries) ? remoteEntries : [];

  const oursKeys = new Set();
  for (const e of ours) {
    const k = keyOf(e);
    if (k) oursKeys.add(k);
  }

  const merged = [...ours];
  let added = 0;
  let kept = 0;
  for (const e of remote) {
    const k = keyOf(e);
    if (k && oursKeys.has(k)) {
      kept++; // shared key — ours already has this exact miss, keep ours
      continue;
    }
    merged.push(e);
    if (k) oursKeys.add(k);
    added++;
  }

  return {
    merged,
    stats: { added, kept, total: merged.length },
  };
}

module.exports = { mergeBwwRoundupLedger, keyOf };
