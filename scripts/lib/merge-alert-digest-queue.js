// Array-of-lines merge for data/audit/alert-digest-queue.json (BRO-257).
//
// Why this exists:
//   scripts/lib/owner-alert-router.js's queueDigestLine() is the only writer
//   at the application level, but it is called from 12+ independent workflows
//   (data-health-check.yml, scrape-new-aggregators.yml, process-feedback.yml,
//   audit-aggregator-gap.yml, check-arm-yield.yml, weekly-affiliate-report.yml,
//   promote-we-aggregator.yml, opening-night-broadcast.yml, opening-night-
//   checklist.yml, ux-walkthrough.yml, update-mezzanine.yml, weekly-
//   integrity.yml, ...), each pushing
//   through push-with-retry.sh independently. Before this fix the file fell to
//   the generic `data/collection-state/*|data/audit/*` case arm below, which
//   resolves a conflict by keeping ONE side's file WHOLESALE ("each run writes
//   independently" — true for most audit logs, false for this one). Two
//   workflows queuing a digest line around the same time would race: whichever
//   rebased/pushed last silently discarded the other's newly-queued line (or,
//   if the other side had *removed* a line via removeDigestLines()/
//   clearDigestQueue(), resurrected a line the app already considered handled).
//   Same data-loss class as feedback-request-ledger.json (task #1440) and
//   express-retry-queue.json (card #1889) — this is their sibling.
//
// Used by:
//   - scripts/lib/merge-commercial-conflict.js (push-with-retry.sh conflict path)
//   - scripts/lib/core-data-merge-registry.js (registers this file + fn)
//   - tests/unit/alert-digest-queue.test.mjs
//
// Merge rules:
//   * shape: a bare top-level array of
//     { conditionKey, title, description, severity, url, decision,
//       decisionPrompt, model, fields, queuedAt }.
//   * Natural key: entry.conditionKey — queueDigestLine() itself already
//     treats this as the unique key (`queue.filter(q => q.conditionKey !==
//     conditionKey)` before pushing a fresh line for the same condition), so
//     the merge mirrors that same "one live line per condition" invariant.
//   * Union of keys is kept: a conditionKey present on only one side survives
//     (this is the fix — the generic keep-local arm dropped these).
//   * On key collision (both sides queued a line for the same conditionKey,
//     e.g. two runs of the same check both re-fired): keep whichever has the
//     LATER queuedAt — mirrors queueDigestLine()'s own "replace the stale
//     line" behavior, so the merge produces the same result the app would
//     have produced had the two writes happened sequentially in one process.
//     Missing/unparsable queuedAt on either side falls back to keeping ours.
//   * Order: ours first (original order preserved), then remote-only entries
//     appended in remote order — deterministic, minimal diff.
//
// KNOWN GAP (accepted, matching feedback-request-ledger.json/express-retry-
// queue.json's siblings): this is a two-way UNION, not base-aware. It cannot
// distinguish "remote never had this conditionKey" from "remote explicitly
// removed it via removeDigestLines()/clearDigestQueue()/drainDigestQueue()" —
// a clear racing with a stale writer's still-queued line can resurrect an
// already-handled condition. Narrow in practice (the consumer that drains
// this queue runs on its own schedule and typically wins any such race by a
// wide margin) and would need explicit tombstones or a base-aware three-way
// merge to close fully — not attempted here, same tradeoff the two sibling
// files already accept.
function keyOf(entry) {
  return entry && typeof entry === 'object' && typeof entry.conditionKey === 'string' && entry.conditionKey
    ? entry.conditionKey
    : null;
}

function queuedAtMs(entry) {
  const t = entry && typeof entry.queuedAt === 'string' ? Date.parse(entry.queuedAt) : NaN;
  return Number.isFinite(t) ? t : null;
}

function pickOnCollision(oursEntry, remoteEntry) {
  const oursMs = queuedAtMs(oursEntry);
  const remoteMs = queuedAtMs(remoteEntry);
  if (remoteMs !== null && oursMs !== null && remoteMs > oursMs) return remoteEntry;
  return oursEntry;
}

/**
 * @param {Array} ours our side's queue array
 * @param {Array} remote remote side's queue array
 * @returns {{merged: Array, stats: {added: number, kept: number, resolvedToRemoteNewer: number, totalEntries: number}}}
 */
function mergeAlertDigestQueue(ours, remote) {
  const oursEntries = Array.isArray(ours) ? ours : [];
  const remoteEntries = Array.isArray(remote) ? remote : [];

  const byKey = new Map();
  for (const e of oursEntries) {
    const k = keyOf(e);
    if (k) byKey.set(k, e);
  }

  const merged = [...oursEntries];
  let added = 0;
  let kept = 0;
  let resolvedToRemoteNewer = 0;
  for (const e of remoteEntries) {
    const k = keyOf(e);
    if (!k) continue;
    const oursEntry = byKey.get(k);
    if (oursEntry) {
      const winner = pickOnCollision(oursEntry, e);
      if (winner !== oursEntry) {
        const idx = merged.indexOf(oursEntry);
        if (idx !== -1) merged[idx] = winner;
        resolvedToRemoteNewer++;
      } else {
        kept++;
      }
      continue;
    }
    merged.push(e);
    byKey.set(k, e);
    added++;
  }

  return {
    merged,
    stats: { added, kept, resolvedToRemoteNewer, totalEntries: merged.length },
  };
}

module.exports = { mergeAlertDigestQueue, keyOf };
