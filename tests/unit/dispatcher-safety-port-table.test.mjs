// Executable backing for docs/dispatcher-safety-port-table.md (BRO-381 Phase 2).
//
// The port-or-delete table gates switching bsc-next.js off. A table that silently
// drifts from the code is worse than no table — it tells the reader a safety
// behaviour was ported when it was deleted, or names a function that no longer
// exists. This test makes the table a living contract:
//
//   1. Every `file : function` the table cites as a SHARED module export must
//      really be exported (require the real module — never a copy).
//   2. Every CLI-internal function the table cites in bsc-next.js must really be
//      defined there (read the real source).
//   3. Every PORT — done row must actually be CALLED by linear-next.js, and every
//      PORT — TODO row must NOT yet be — so porting a TODO (or regressing a done)
//      fails this test and forces the table row to be updated in lockstep.
//   4. The H1 gap (acceptance recheck walks Notion, not Linear) must still hold.
//
// When you port a TODO to linear-next.js, this test will fail on purpose: move the
// row to PORT — done in the markdown and flip it in PORT_TODO_ABSENT_IN_LINEAR below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const lib = (name) => require(join(REPO, 'scripts', 'lib', name));
const readSrc = (rel) => readFileSync(join(REPO, rel), 'utf8');

// (1) Shared-module exports named in the table. Require the REAL module and assert
// each cited symbol exists. Renaming/removing any of these fails here → update the row.
const SHARED_EXPORTS = {
  'dispatch-guards.js': [
    'findLiveWorkspaceForTask', 'deadDispatchGuard', 'checkDeadDispatch', 'parkedGuard',
    'workBranchCollisionGuard', 'linearMirrorGuard', 'loadLinearMirrorMapping',
    'staleOutcomeGuard', 'isNativeTaskDoneWithoutCard', 'evaluateVerifiability',
    'classifyHeadlessDispatchability',
  ],
  'dispatch-ledger.js': [
    'titleMatchesSubject', 'dispatchCapDecision', 'classifyDeadAttemptsForTask',
    'deadBreadcrumbs', 'parkedTasks', 'detectLauncherOutage', 'successionDepthForTask',
    'SUCCESSION_DEPTH_CAP', 'DEAD_ATTEMPT_LIMIT', 'INFRA_DEAD_ATTEMPT_LIMIT',
  ],
  'linear-dispatch.js': [
    'checkTerminalStateGuard', 'findUnresolvedDispatchComment', 'hasLiveLedgerEntry',
    'sortIssuesByPriority', 'issueLabelNames',
  ],
  'bsc-runner.js': [
    'acquireLease', 'releaseLease', 'pidLooksLikeClaude', 'buildBudgetPreamble',
    'runJob',
    // provisionJobWorktree / teardownJobWorktree (G4) are internal to runJob,
    // not exports — asserted against the source below.
  ],
  'bsc-next-model.js': ['resolveModel'],
  'verify-gate.js': ['evaluateVerifiability'],
  'headless-dispatchability.js': ['classifyHeadlessDispatchability'],
  'cmux-launch.js': [
    'launchCmuxSession', 'waitForLaunchOutcome', 'verifiedAlive', 'osProcessAliveForSeed',
    'hasSeedProcess', 'shouldAdoptLateStart', 'strictlyAliveWorkspace', 'shouldRefuseForAuth',
    'shouldPreWake', 'cmuxIdleSec', 'setAppFocus', 'osActivateCmuxApp',
  ],
  'cmux-launch-state.js': ['decideLaunchWait'],
  'dispatch-card-drift.js': ['detectDrift', 'looksUnsafeToType'],
  'dispatch-overlap-check.js': ['findOverlappingCards'],
  'ci-red-dispatch-heuristic.js': ['extractCiRedTarget'],
  'autonomous-eligibility.js': ['isExcludedCategory', 'EXCLUDED_CATEGORIES'],
  'worktree-branch-guard.js': ['listWorkBranchStatuses'],
};

for (const [mod, names] of Object.entries(SHARED_EXPORTS)) {
  test(`table references real exports of scripts/lib/${mod}`, () => {
    const m = lib(mod);
    for (const name of names) {
      assert.ok(name in m, `docs/dispatcher-safety-port-table.md names ${mod} : ${name}, but it is not exported`);
      assert.notEqual(m[name], undefined, `${mod} : ${name} is exported as undefined`);
    }
  });
}

// The cap values the table quotes verbatim must match the constants.
test('table quotes the real cap constants', () => {
  const led = lib('dispatch-ledger.js');
  assert.equal(led.DEAD_ATTEMPT_LIMIT, 2, 'A2 quotes DEAD_ATTEMPT_LIMIT=2');
  assert.equal(led.INFRA_DEAD_ATTEMPT_LIMIT, 10, 'A2 quotes INFRA_DEAD_ATTEMPT_LIMIT=10');
  assert.equal(led.SUCCESSION_DEPTH_CAP, 5, 'D1 quotes SUCCESSION_DEPTH_CAP=5');
});

// (2) CLI-internal functions cited in bsc-next.js (not exported — read the source).
test('table references real functions defined in scripts/bsc-next.js', () => {
  const src = readSrc('scripts/bsc-next.js');
  const CLI_FNS = [
    'completedLaunchGuard', 'successionRefusal', 'acquireSuccessionLock',
    'releaseSuccessionLock', 'pageSuccessionCapExceeded', 'runAmend',
    'occupantStillThisTask', 'recordCiRedClaim', 'actionable',
  ];
  for (const fn of CLI_FNS) {
    assert.match(src, new RegExp(`function ${fn}\\b|${fn}\\s*=`),
      `docs table names bsc-next.js : ${fn}, but no definition found`);
  }
});

// (2b) Internal (non-exported) helpers cited by the table — read the real source.
test('table references real internal helpers of scripts/lib/bsc-runner.js', () => {
  const src = readSrc('scripts/lib/bsc-runner.js');
  for (const fn of ['provisionJobWorktree', 'teardownJobWorktree']) {
    assert.match(src, new RegExp(`function ${fn}\\b|${fn}\\s*=`),
      `docs table names bsc-runner.js : ${fn} (G4), but no definition found`);
  }
});

// (3a) PORT — done rows: the shared guard/primitive must actually be invoked by
// linear-next.js. If one stops being called, the "done" claim is a lie → fail.
const PORT_DONE_CALLED_IN_LINEAR = [
  'findLiveWorkspaceForTask', // A1
  'checkDeadDispatch',        // A2/A3 (deadDispatchGuard is reached via this)
  'parkedGuard',              // A4
  'evaluateVerifiability',    // B1
  'classifyHeadlessDispatchability', // B2
  'checkTerminalStateGuard',  // B4
  'launchCmuxSession',        // C1–C5 (whole cmux primitive)
  'resolveModel',             // F2
  'findUnresolvedDispatchComment', // G1
  'hasLiveLedgerEntry',       // G1
  'runJob',                   // G2–G4
  'workBranchCollisionGuard', // A5 (BRO-278)
  'listWorkBranchStatuses',   // A5 (BRO-278)
];

test('PORT — done rows are actually called by scripts/linear-next.js', () => {
  const src = readSrc('scripts/linear-next.js');
  for (const sym of PORT_DONE_CALLED_IN_LINEAR) {
    assert.match(src, new RegExp(`\\b${sym}\\b`),
      `Table marks ${sym} PORT — done, but linear-next.js never references it — the port regressed`);
  }
});

// (3b) PORT — TODO rows: the behaviour must NOT yet be wired into linear-next.js.
// When you port one, this fails on purpose — move the row to PORT — done and drop
// the symbol from this list.
const PORT_TODO_ABSENT_IN_LINEAR = [
  'detectLauncherOutage',     // C6
  'successionRefusal',        // D1
  'runAmend',                 // E1
  'recordCiRedClaim',         // E3
];

test('PORT — TODO / DELETE rows are not yet wired into scripts/linear-next.js', () => {
  const src = readSrc('scripts/linear-next.js');
  for (const sym of PORT_TODO_ABSENT_IN_LINEAR) {
    assert.doesNotMatch(src, new RegExp(`\\b${sym}\\b`),
      `${sym} now appears in linear-next.js — if you ported it, move its row to PORT — done in ` +
      `docs/dispatcher-safety-port-table.md and remove it from PORT_TODO_ABSENT_IN_LINEAR`);
  }
});

// (4) H1 gap: the nightly acceptance recheck still walks only the Notion board.
test('H1 gap holds: acceptance recheck is Notion-only, not Linear', () => {
  const src = readSrc('scripts/autonomous-acceptance-recheck.js');
  assert.match(src, /notion/i, 'recheck should reference the Notion board (H1 premise)');
  assert.doesNotMatch(src, /\blinear\b/i,
    'autonomous-acceptance-recheck.js now references Linear — H1 may be resolved; update the table');
});

// (5) The deliverable exists and every row id it tallies is present in the table.
test('every row id in the summary appears in the table body', () => {
  const doc = readSrc('docs/dispatcher-safety-port-table.md');
  const ROW_IDS = [
    'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7',
    'B1', 'B2', 'B3', 'B4', 'B5',
    'C1', 'C2', 'C3', 'C4', 'C5', 'C6',
    'D1', 'D2', 'D3',
    'E1', 'E2', 'E3',
    'F1', 'F2', 'F3',
    'G1', 'G2', 'G3', 'G4',
    'H1', 'H2', 'H3', 'H4', 'H5',
  ];
  for (const id of ROW_IDS) {
    assert.match(doc, new RegExp(`\\| ${id} \\|`), `row ${id} missing from the table body`);
  }
});
