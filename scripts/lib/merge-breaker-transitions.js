'use strict';

// JSONL append-only merge for data/audit/breaker-transitions.jsonl (BRO-3022).
//
// WHY THIS FILE EXISTS AT ALL. The two breaker checkers commit their state in
// commercial-rss-poll.yml's dedicated early "Commit breaker state" step, which
// BRO-2960 created and BRO-335 then tuned (PUSH_DEADLINE_SEC=300) precisely
// because that push was losing its race. push-with-retry.sh's disqualifier
// (~L2160) skips the Git Data API fallback outright when the outgoing diff
// touches "an unaudited data/audit/ path" — so adding the transitions ledger to
// that step WITHOUT a registry entry would have silently degraded the push
// budget for the breaker state itself, undoing the fix. Registering the file
// apiFallbackMerge keeps the fallback available; this is the merge function it
// runs against the live remote tip on every retry.
//
// Modelled directly on scripts/lib/merge-alert-router-attempts.js, same shape,
// same rules:
//   * shape: one JSON object per line —
//     { ts, conditionKey, from, to, day, units, ceiling, ceilingSource, prevTs }.
//   * Pure append-only log with no "latest wins" semantics: a later transition
//     never supersedes an earlier one, both are real distinct events. Union
//     both sides' lines, deduped by (ts, conditionKey) — an exact-timestamp
//     collision on the same condition is the only way two independent writers
//     could produce an indistinguishable duplicate, and there it is the SAME
//     event observed twice, so dropping it is correct.
//   * NO base-aware delete handling, unlike merge-alert-router-attempts.js.
//     That file needs it because its writer prunes on a retention window and a
//     naive union resurrects every pruned row. This writer
//     (scripts/lib/breaker-transitions.js) never prunes and never rewrites:
//     transitions are a handful of rows a WEEK, so the file stays small
//     indefinitely and there is no local delete for a merge to honor. `base` is
//     accepted for call-signature parity and deliberately ignored — if a
//     retention prune is ever added to the writer, this must grow the same
//     base-aware branch its sibling has, or retention will silently never
//     shrink the file.
//   * Order: ours first (original order preserved), then remote-only lines in
//     remote order — deterministic, minimal diff, matches the convention in
//     merge-feedback-ledger.js. Readers never depend on it: every reader in
//     breaker-transitions.js re-sorts by the explicit `ts` field first, which
//     is what makes this file legal under merge=union at all.

function keyOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return `${entry.ts || ''} ${entry.conditionKey || ''}`;
}

function mergeBreakerTransitions(local, remote, _base) {
  const localEntries = Array.isArray(local) ? local : [];
  const remoteEntries = Array.isArray(remote) ? remote : [];

  const localKeys = new Set(localEntries.map(keyOf));
  const remoteOnly = remoteEntries.filter((e) => !localKeys.has(keyOf(e)));

  return {
    merged: [...localEntries, ...remoteOnly],
    stats: {
      local: localEntries.length,
      remote: remoteEntries.length,
      merged: localEntries.length + remoteOnly.length,
      remoteOnly: remoteOnly.length,
      deletesHonored: 0,
    },
  };
}

module.exports = { mergeBreakerTransitions };
