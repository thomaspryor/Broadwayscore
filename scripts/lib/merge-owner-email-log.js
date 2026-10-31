// Append-only-ledger merge for data/audit/owner-email-log.jsonl.
//
// Why this exists (task #809, 3rd sibling of task #698's bww-roundup-miss-
// ledger fix and task #784's scraper-spend-ledger fix): discord-notify.js's
// logOwnerEmailSent() does a local readFileSync + filter(retention) + push +
// writeFileSync — not a true append. sendEmailAlert() is called from ~25
// call sites across 23 workflows that push through push-with-retry.sh, so
// two runs sending an owner email in the same push window race on this file.
// `git rebase -X theirs` resolves a conflicting hunk in favour of the
// replayed local commit WITHOUT ever reporting a conflict (same #420 class
// as commercial-pending-review.json et al.), so the losing run's appended
// line can be silently dropped instead of unioned — undercounting sends in
// readOwnerEmailLog()'s BSC Daily digest section and, if this log were ever
// used for send suppression instead of pure observability, risking a
// missed-cooldown double-send.
//
// Used by:
//   - scripts/lib/reconcile-merged-json.js (post-rebase reconcile pass,
//     opt-in via PUSH_RECONCILE_MERGED_JSON=1 on the committing step)
//   - tests/unit/merge-owner-email-log.test.mjs
//
// Merge rules:
//   * Shape: array of {ts, title, severity} entries (one per JSONL line —
//     see logOwnerEmailSent() in discord-notify.js).
//   * Natural key: `${ts}|${title}|${severity}` — a real duplicate write
//     (the log read back as both "ours" and "remote" after an amend)
//     collapses to one line; two genuinely different sends sharing a title
//     (e.g. the same alert firing twice at different timestamps) are NOT
//     duplicates and both survive.
//   * Union of keys is kept: entries present on only one side survive. This
//     is the whole point — a concurrent run's send must never be dropped
//     just because it landed in the same rebase window as another run's.
//   * logOwnerEmailSent() also trims entries older than
//     SEND_LOG_RETENTION_DAYS on every write, so "ours" and "remote" can
//     each have trimmed at a slightly different cutoff — the union here can
//     end up marginally wider than either side for one cycle; the next
//     write re-trims. Safe, matches the never-drop intent.
//   * Keyless entries (missing ts, title, or severity — e.g. a hand-edited
//     or torn line) are kept verbatim from ours but can't be deduped
//     against remote; they pass through unchanged, matching
//     mergeBwwRoundupLedger's/mergeScraperSpendLedger's safe never-drop
//     behaviour. A genuinely CORRUPT line (unparsable JSON) never reaches
//     this function at all — reconcile-merged-json.js's parseJsonlLines()
//     throws on those, which skips reconciliation for the whole file rather
//     than silently dropping the line and committing that deletion.
//   * Order: ours first (original append order preserved), then remote-only
//     entries appended in remote order — deterministic, minimal diff.
//     readOwnerEmailLog() only filters by cutoff and doesn't assume
//     ordering, so this is safe.

function keyOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!entry.ts || !entry.title || !entry.severity) return null;
  return `${entry.ts}|${entry.title}|${entry.severity}`;
}

function mergeOwnerEmailLog(oursEntries, remoteEntries) {
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
      kept++; // shared key — ours already has this exact send, keep ours
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

module.exports = { mergeOwnerEmailLog, keyOf };
