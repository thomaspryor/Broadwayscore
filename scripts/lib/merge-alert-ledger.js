'use strict';

// Keyed-object merge for data/audit/alert-ledger.json (BRO-2413).
//
// Why this exists: this ledger has 12 independent writers (routeAlert()
// callers across the whole alert-router fanout — see core-data-merge-
// registry.js's "NOT added, deliberately" comment and scripts/lib/push-
// content-survival.js's CONTENT_SURVIVAL_EXEMPT_LEDGERS entry), so it was
// deliberately excluded from apiFallbackSafe (that flag means "no merge
// needed" — false here) and from push-via-git-api.sh's fast Git Data API
// path entirely (whole-file "ours wins outright" would silently discard
// every OTHER writer's condition that landed since our checkout). That left
// it on the slow local fetch+rebase+push loop, which is what was losing
// races and exhausting retries (task evidence: data-health-check.yml runs
// 32943226287, 33869398248). This merge function is what makes it SAFE to
// route through the fast path instead: real reconciliation, not a bypass.
//
// Loss here is already explicitly accepted at a coarser grain than this
// merge even attempts to fix — owner-alert-router.js's own module header
// (and push-content-survival.js's exemption) documents that a losing
// writer's ENTIRE commit getting overwritten by the old last-writer-wins
// flow is "a duplicate card/email, not a crash or lost alert — acceptable
// for a single-owner project". This merge is a strict improvement on that
// baseline (it unions conditions instead of dropping a whole side), not a
// new correctness bar the file didn't already clear.
//
// Merge rules:
//   * shape: { conditions: { conditionKey: {status, disposition, title,
//     firstSeen, lastSeen, lastNotifiedAt, notifyCount, cardId, ...} } }
//   * Union of conditionKeys is kept: a key present on only one side survives
//     — EXCEPT (BRO-2413 round-2, Codex adversarial ship-check P0 finding):
//     `deleteCondition()` (owner-alert-router.js) HARD-DELETES a key (used
//     for synthetic/test conditions, e.g. the E2E canary) — a naive 2-way
//     union would silently resurrect it from remote's stale copy, exactly
//     the "our intentional clear gets undone" bug class BASE snapshots
//     exist to prevent elsewhere in this codebase (reconcile-shows-fields.js's
//     `baseAvailable && !baseMap.has(id)` check is the same pattern). When a
//     `base` snapshot is supplied and a remote-only key was ALSO present in
//     base, it is treated as an intentional local delete and NOT restored.
//     `base` is optional (two-way callers keep prior behavior — every
//     remote-only key is restored) since not every call site can supply a
//     merge-base snapshot; three-way callers (push-via-git-api.sh) always can.
//   * On key collision: keep whichever side's entry has the LATER `lastSeen`
//     (freshest observed state — an open incident that re-fired more
//     recently on one side is more accurate than the other side's stale
//     snapshot). Unparsable/missing lastSeen loses the comparison; an exact
//     tie or both-unparsable keeps ours, matching this codebase's other
//     mergers' tie-break convention (mergeReviewsJson's snapshotIsNewer).
//   * KNOWN LIMITATION (accepted, not fixed here): a collision picks the
//     WHOLE record from whichever side has the fresher lastSeen, not a
//     per-field merge — `resolveCondition()` flips `status`/`resolvedAt`
//     without advancing `lastSeen`, so a concurrent still-open record with a
//     newer lastSeen can out-select a genuine resolution. This is a
//     narrower, strictly-better-than-before instance of the SAME whole-
//     record "ours wins outright on conflict" loss class this file's
//     divergence was already explicitly accepted for (see push-content-
//     survival.js's CONTENT_SURVIVAL_EXEMPT_LEDGERS entry and owner-alert-
//     router.js's own module header) — union-with-base-aware-deletes is a
//     strict improvement on the OLD whole-file "ours wins outright" default
//     (which dropped ALL of the losing side's keys, not just one field of
//     one record), not a new correctness bar the file didn't already clear.
//     A future per-field reconciliation pass (mirroring reconcile-shows-
//     fields.js's RECONCILABLE_FIELDS) would close this; out of scope here.

function tsOrNull(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function mergeAlertLedger(local, remote, base) {
  const localConditions = (local && typeof local.conditions === 'object' && local.conditions) || {};
  const remoteConditions = (remote && typeof remote.conditions === 'object' && remote.conditions) || {};
  const baseConditions = (base && typeof base.conditions === 'object' && base.conditions) || null;

  const merged = { ...localConditions };
  let remoteOnly = 0;
  let deletesHonored = 0;
  let conflictsResolvedToRemote = 0;

  for (const key of Object.keys(remoteConditions)) {
    if (!(key in merged)) {
      if (baseConditions && key in baseConditions) {
        // Present in base, present on remote, absent locally: WE deleted it
        // (deleteCondition()) — do not let remote's stale copy resurrect it.
        deletesHonored++;
        continue;
      }
      merged[key] = remoteConditions[key];
      remoteOnly++;
      continue;
    }
    const oursTs = tsOrNull(merged[key] && merged[key].lastSeen);
    const remoteTs = tsOrNull(remoteConditions[key] && remoteConditions[key].lastSeen);
    if (remoteTs !== null && (oursTs === null || remoteTs > oursTs)) {
      merged[key] = remoteConditions[key];
      conflictsResolvedToRemote++;
    }
  }

  return {
    merged: { ...local, conditions: merged },
    stats: {
      localKeys: Object.keys(localConditions).length,
      remoteKeys: Object.keys(remoteConditions).length,
      mergedKeys: Object.keys(merged).length,
      remoteOnly,
      deletesHonored,
      conflictsResolvedToRemote,
    },
  };
}

module.exports = { mergeAlertLedger };
