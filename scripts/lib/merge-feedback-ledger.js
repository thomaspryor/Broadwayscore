// Array-of-entries merge for data/audit/feedback-request-ledger.json.
//
// Why this exists (task #1440):
//   The generic `data/collection-state/*|data/audit/*` rule in
//   push-with-retry.sh resolves a conflict by keeping ONE side's file
//   wholesale ("each run writes independently" — true for most audit logs,
//   which are per-run snapshots). This ledger is not that: it accumulates
//   entries across runs and is the single source of truth for "did this
//   request actually ship." Before task #1440 it had one writer
//   (process-feedback.yml). It now has two — process-feedback.yml and
//   generate-remediation-plan.js (via auto-fix-feedback-bug.yml) — so a
//   whole-file "keep local" on conflict would silently drop the OTHER
//   workflow's newly-added or newly-flipped-to-live entries, recreating the
//   exact silent-loss bug this ledger exists to prevent.
//
// Used by:
//   - scripts/lib/merge-commercial-conflict.js (push-with-retry.sh conflict path)
//   - tests/unit/merge-feedback-ledger.test.mjs
//
// Merge rules:
//   * shape: { entries: [ { key, status, ... }, ... ] }
//   * Natural key: entry.key (same key evaluateEntry()/mergeEntries() use).
//   * Union of keys is kept: an entry present on only one side survives.
//   * On key collision (both sides carry the entry): keep OURS (the local
//     side). Losing a status flip on the other side is self-healing — the
//     entry just stays 'open' and gets re-evaluated by
//     verify-feedback-requests-live.js on its next scheduled run, unlike a
//     dropped ADDITION, which is unrecoverable.
//   * Order: ours first (original order preserved), then remote-only entries
//     appended in remote order — deterministic, minimal diff.

function keyOf(entry) {
  return entry && typeof entry === 'object' && entry.key ? entry.key : null;
}

/**
 * @param {{entries?: Array}} local
 * @param {{entries?: Array}} remote
 * @returns {{merged: {entries: Array}, stats: {local: number, remote: number, merged: number, remoteOnly: number}}}
 */
function mergeFeedbackLedger(local, remote) {
  const localEntries = Array.isArray(local?.entries) ? local.entries : [];
  const remoteEntries = Array.isArray(remote?.entries) ? remote.entries : [];

  const localKeys = new Set(localEntries.map(keyOf).filter(Boolean));
  const remoteOnly = remoteEntries.filter((e) => {
    const k = keyOf(e);
    return k && !localKeys.has(k);
  });

  return {
    merged: { entries: [...localEntries, ...remoteOnly] },
    stats: {
      local: localEntries.length,
      remote: remoteEntries.length,
      merged: localEntries.length + remoteOnly.length,
      remoteOnly: remoteOnly.length,
    },
  };
}

module.exports = { mergeFeedbackLedger };
