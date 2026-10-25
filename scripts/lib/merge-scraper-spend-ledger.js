// Append-only-ledger merge for data/audit/scraper-spend-ledger.jsonl.
//
// Why this exists (task #784, sibling of task #698's bww-roundup-miss-ledger
// fix): provider-telemetry.js's _appendLedgerLine() does a local
// readFileSync + push + writeFileSync — not a true append. At least 5
// workflows (collect-review-texts.yml matrix, gather-reviews.js,
// opening-night-poller.js, sweep-we-aggregators.js x2, scrape-thestage-
// roundups.js) call this from separate CI runners/checkouts that can be in
// flight concurrently. `git rebase -X theirs` resolves a conflicting hunk in
// favour of the replayed local commit WITHOUT ever reporting a conflict (same
// #420 class as commercial-pending-review.json et al.), so the losing run's
// appended row(s) can be silently dropped instead of unioned.
//
// Used by:
//   - scripts/lib/reconcile-merged-json.js (post-rebase reconcile pass,
//     opt-in via PUSH_RECONCILE_MERGED_JSON=1 on the committing step)
//   - tests/unit/provider-telemetry.test.mjs
//
// Merge rules:
//   * Shape: array of provider-call record objects (one per JSONL line — see
//     recordProviderCall() in provider-telemetry.js). No single field is a
//     unique event ID, so the natural key is the FULL serialized record: two
//     rows collapse only when every field matches exactly (the read-back-as-
//     both-ours-and-remote case after an amend — a real duplicate of the same
//     write, not two distinct calls). Two genuinely different calls — even
//     ones sharing ts/provider/host/fn — survive as long as ANY field differs
//     (status, credits, script, purpose, etc. commonly do).
//   * Union of keys is kept: entries present on only one side survive. This
//     is the whole point — a concurrent runner's call must never be dropped
//     just because it landed in the same rebase window as another runner's.
//   * Keyless entries (not a parseable object, e.g. a hand-edited or torn
//     line) are kept verbatim from ours but can't be deduped against remote;
//     they pass through unchanged, matching mergeBwwRoundupLedger's/
//     mergeDiaryShows' safe never-drop behaviour. A genuinely CORRUPT line
//     (unparsable JSON) never reaches this function at all — reconcile-
//     merged-json.js's parseJsonlLines() throws on those, which skips
//     reconciliation for the whole file rather than silently dropping the
//     line and committing that deletion.
//   * Order: ours first (original append order preserved), then remote-only
//     entries appended in remote order — deterministic, minimal diff.
//     countCallsByProvider/topCallers/computeAttributedPct only aggregate by
//     day+provider, never assume ordering, so this is safe.

function keyOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  try {
    return JSON.stringify(entry);
  } catch {
    return null;
  }
}

function mergeScraperSpendLedger(oursEntries, remoteEntries) {
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
      kept++; // exact-duplicate key — ours already has this exact row, keep ours
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

module.exports = { mergeScraperSpendLedger, keyOf };
