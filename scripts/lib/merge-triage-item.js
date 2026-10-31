'use strict';

// Merge for data/audit/triage/*.json (BRO-2782): alert-router state, auto-fix
// counters and prior-run snapshots, one small JSON object per file.
//
// Each file has a single CI writer (health-check.js, triage-unopened-shows.mjs
// and analyze-rebuild-drops.js; see the card), so there is nothing to
// reconcile: our staged copy wins. Picking the fresher of two copies by
// timestamp would replace the whole object and could drop our autoFixAttempts
// increment, which feeds the daily auto-fix cap. The fallback only overlays
// paths in our own diff, so a remote change to a file we did not touch is
// never at risk. The merge exists so the fallback can run; it keeps remote
// only when we have nothing usable.

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mergeTriageItem(local, remote) {
  if (isPlainObject(local)) {
    return { merged: local, stats: { source: 'ours' } };
  }
  if (isPlainObject(remote)) {
    return { merged: remote, stats: { source: 'remote' } };
  }
  return { merged: local, stats: { source: 'ours-unusable' } };
}

module.exports = { mergeTriageItem };
