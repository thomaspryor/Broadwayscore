'use strict';

// Keyed-object merge for data/audit/guard-escalation-state.json (BRO-447).
//
// Why this exists: this file is genuinely multi-writer — 3 independent guard
// scripts (scripts/check-corpus-drift.js's GUARD_ID
// 'corpus-drift-audit-crash', scripts/check-rebuild-staleness.js's
// 'stale-checkout-staleness', scripts/check-vercel-build-guard.js's
// 'vercel-build-guard-restore-failed') each persist their own top-level key
// via saveGuardState() (scripts/lib/guard-escalation.js's nextGuardState()),
// invoked from 3 DIFFERENT workflows with 3 DIFFERENT concurrency groups
// (check-corpus-drift, rebuild-reviews, vercel-build-guard) — so, unlike a
// single-writer apiFallbackSafe file, overlapping runs of DIFFERENT
// workflows can race into the same push. That disqualified the whole commit
// from push-with-retry.sh's Git Data API fallback (it was neither
// apiFallbackSafe nor apiFallbackMerge), leaving check-corpus-drift.yml on
// the slow local fetch+rebase+push loop — the loop that was losing races
// against main-branch churn and hard-failing the job 3x/24h (BRO-447).
//
// Each guard script only ever reads and writes its OWN top-level key (see
// check-vercel-build-guard.js:45's comment) — a whole-file "ours wins
// outright" overlay would still be WRONG here despite that design, because
// it would silently drop whichever OTHER guard's key the remote tip picked
// up since our checkout (the exact class of loss mergeAlertLedger was built
// to close for alert-ledger.json). This merge unions the top-level keys
// instead: a key present on only one side always survives, and a same-key
// collision (not expected under the current one-writer-per-key design, but
// not structurally prevented either) keeps whichever side's state is
// fresher by max(lastBlockedAt, lastClearedAt) — mirroring
// mergeAlertLedger's lastSeen tie-break, with ours winning an exact tie or
// unparsable timestamps on both sides. Same accepted clock-trust model as
// every other merge fn in this registry (all compare runner wall-clock
// timestamps) — not a new risk class this file introduces.
//
// `base` (optional 3rd arg, supplied by push-via-git-api-merge.js on every
// call) gets the same delete-aware treatment as mergeAlertLedger: no guard
// script deletes its own key TODAY, but if one ever does (e.g. a guard is
// retired/renamed), a naive 2-way union would resurrect the deleted key from
// remote's stale copy forever, since nothing else would ever remove it
// again. Restoring a remote-only key is skipped when that key was already
// present in base — i.e. treated as an intentional local delete — same rule,
// same reasoning as mergeAlertLedger.js.

function freshnessOf(state) {
  if (!state || typeof state !== 'object') return null;
  const a = Number.isFinite(state.lastBlockedAt) ? state.lastBlockedAt : null;
  const b = Number.isFinite(state.lastClearedAt) ? state.lastClearedAt : null;
  if (a === null && b === null) return null;
  return Math.max(a ?? -Infinity, b ?? -Infinity);
}

function mergeGuardEscalationState(local, remote, base) {
  const localDoc = (local && typeof local === 'object' && !Array.isArray(local)) ? local : {};
  const remoteDoc = (remote && typeof remote === 'object' && !Array.isArray(remote)) ? remote : {};
  const baseDoc = (base && typeof base === 'object' && !Array.isArray(base)) ? base : null;

  const merged = { ...localDoc };
  let remoteOnly = 0;
  let deletesHonored = 0;
  let conflictsResolvedToRemote = 0;

  for (const key of Object.keys(remoteDoc)) {
    if (!(key in merged)) {
      if (baseDoc && key in baseDoc) {
        // Present in base, present on remote, absent locally: WE deleted it
        // — do not let remote's stale copy resurrect it.
        deletesHonored++;
        continue;
      }
      merged[key] = remoteDoc[key];
      remoteOnly++;
      continue;
    }
    const oursFresh = freshnessOf(merged[key]);
    const remoteFresh = freshnessOf(remoteDoc[key]);
    if (remoteFresh !== null && (oursFresh === null || remoteFresh > oursFresh)) {
      merged[key] = remoteDoc[key];
      conflictsResolvedToRemote++;
    }
  }

  return {
    merged,
    stats: {
      localKeys: Object.keys(localDoc).length,
      remoteKeys: Object.keys(remoteDoc).length,
      mergedKeys: Object.keys(merged).length,
      remoteOnly,
      deletesHonored,
      conflictsResolvedToRemote,
    },
  };
}

module.exports = { mergeGuardEscalationState };
