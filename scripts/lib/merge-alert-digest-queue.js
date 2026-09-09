'use strict';

// Bare-array merge for data/audit/alert-digest-queue.json (BRO-2413).
//
// Same rationale as merge-alert-ledger.js: 8 independent writers (see core-
// data-merge-registry.js's "NOT added, deliberately" comment), deliberately
// excluded from apiFallbackSafe and from push-via-git-api.sh's fast path —
// this merge is what makes that path safe instead of a bypass.
//
// Merge rules:
//   * shape: a bare array of { conditionKey, title, description, severity,
//     url, decision, decisionPrompt, model, fields, queuedAt }.
//   * Natural key: conditionKey — queueDigestLine() (scripts/lib/owner-alert-
//     router.js) already treats it as unique, replacing any existing queued
//     line for the same condition rather than stacking duplicates.
//   * Union of conditionKeys is kept: an entry present on only one side
//     survives (this is the fix — the old whole-file overwrite would drop
//     every OTHER writer's queued row wholesale) — EXCEPT (BRO-2413 round-2,
//     Codex adversarial ship-check P0 finding): `clearDigestQueue()` writes
//     `[]` after the digest has been durably delivered, and
//     `removeDigestLines()` removes specific rows once drained — a naive
//     2-way union would silently RESURRECT an already-delivered row from
//     remote's stale pre-drain copy, defeating the whole point of a
//     deliver-once digest. When a `base` snapshot is supplied and a
//     remote-only conditionKey was ALSO present in base, it is treated as an
//     intentional local drain/removal and NOT restored. `base` is optional
//     (two-way callers keep prior behavior — every remote-only row is
//     restored) since not every call site can supply a merge-base snapshot;
//     three-way callers (push-via-git-api.sh) always can.
//   * On key collision: keep whichever side's entry has the LATER
//     `queuedAt` (the queue's own recency field). Unparsable/missing
//     queuedAt loses the comparison; a tie keeps ours.

function tsOrNull(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function keyOf(entry) {
  return entry && typeof entry === 'object' && typeof entry.conditionKey === 'string' ? entry.conditionKey : null;
}

function mergeAlertDigestQueue(local, remote, base) {
  const localQueue = Array.isArray(local) ? local : [];
  const remoteQueue = Array.isArray(remote) ? remote : [];
  const baseKeys = Array.isArray(base) ? new Set(base.map(keyOf).filter(Boolean)) : null;

  const byKey = new Map();
  const keyless = [];
  for (const e of localQueue) {
    const k = keyOf(e);
    if (k) byKey.set(k, e); else keyless.push(e);
  }

  let remoteOnly = 0;
  let deletesHonored = 0;
  let conflictsResolvedToRemote = 0;
  for (const e of remoteQueue) {
    const k = keyOf(e);
    if (!k) continue; // keyless remote entries are not recoverable without a dedup key — accepted loss, same bar as before this fix
    if (!byKey.has(k)) {
      if (baseKeys && baseKeys.has(k)) {
        // Present in base, present on remote, absent locally: WE drained/
        // removed it (clearDigestQueue()/removeDigestLines()) — do not let
        // remote's stale copy resurrect an already-delivered row.
        deletesHonored++;
        continue;
      }
      byKey.set(k, e);
      remoteOnly++;
      continue;
    }
    const ours = byKey.get(k);
    const oursTs = tsOrNull(ours.queuedAt);
    const remoteTs = tsOrNull(e.queuedAt);
    if (remoteTs !== null && (oursTs === null || remoteTs > oursTs)) {
      byKey.set(k, e);
      conflictsResolvedToRemote++;
    }
  }

  return {
    merged: [...byKey.values(), ...keyless],
    stats: {
      local: localQueue.length,
      remote: remoteQueue.length,
      merged: byKey.size + keyless.length,
      remoteOnly,
      deletesHonored,
      conflictsResolvedToRemote,
    },
  };
}

module.exports = { mergeAlertDigestQueue };
