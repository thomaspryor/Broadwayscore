#!/usr/bin/env node
// scripts/lib/orphan-test-gate.js — pure decision function for scoping
// scripts/audit-orphan-tests.js's pass/fail to the diff being pushed.
//
// Card #1488: the orphan-tests audit's TRIGGER (whether to run at all) was
// already diff-scoped in scripts/lib/run-push-audits.sh, but the CHECK itself
// was not — once triggered, it failed on ANY unregistered test file anywhere
// in the repo, including ones the current push never touched. Two unrelated
// merges (cards #483, #1478) were blocked by pre-existing orphans elsewhere.
//
// changedFiles === undefined/null means "unscoped" — every orphan blocks.
// This is what CI's direct, unscoped calls to audit-orphan-tests.js get, so
// CI keeps acting as the full-repo safety net exactly as before this change.
//
// Tested by scripts/lib/orphan-test-gate.test.mjs (CLAUDE.md rule 15 — the
// test require()s this function, it does not restate the logic).

'use strict';

// orphans: [{ name, rel }] — unregistered test files (already exempt-filtered
// by the caller). changedFiles: string[] | Set<string> | null | undefined —
// repo-relative paths touched by the push being gated.
function decideOrphanGate({ orphans, changedFiles }) {
  if (changedFiles == null) {
    return { blocking: orphans, informational: [] };
  }
  const scope = changedFiles instanceof Set ? changedFiles : new Set(changedFiles);
  const blocking = orphans.filter(o => scope.has(o.rel));
  const informational = orphans.filter(o => !scope.has(o.rel));
  return { blocking, informational };
}

module.exports = { decideOrphanGate };
