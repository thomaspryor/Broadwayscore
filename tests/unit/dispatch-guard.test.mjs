// BRO-278 — duplicate-dispatch guard misses same-task collisions across
// sessions. Real incident, 2026-08-12: three cmux workspaces (345/347/348)
// independently ran the identical migration handoff, undetected until a
// human happened to run `cmux list-workspaces` by hand.
//
// Root cause: scripts/lib/dispatch-guards.js's matchesTaskWorkBranch(name,
// taskId) anchored the RAW taskId against branch names. A Linear-issue
// dispatch's ledger taskId is namespaced `linear:BRO-278` (linear-next.js's
// ledgerTaskId()), but the branch actually created for that dispatch is
// `job/linear-BRO-278-<suffix>` — bsc-runner.js's gitSafeJobId() sanitizes
// the git-illegal colon to a dash before the branch is ever created. Because
// matchesTaskWorkBranch never applied that same sanitization, it could NEVER
// match a Linear branch — workBranchCollisionGuard (card #1281's original
// cross-session collision guard) was structurally blind to every
// Linear-issue collision. On top of that, linear-next.js never called the
// guard at all (docs/dispatcher-safety-port-table.md row A5 was PORT — TODO).
//
// This file requires the REAL functions (CLAUDE.md rule 15 — never copy
// guard logic into a test) and reproduces the exact incident shape: the same
// work item (a Linear issue) dispatched from two different sessions, each
// getting its own randomly-suffixed worktree/branch, so no branch NAME is
// ever identical — only the work-item id embedded in it is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  matchesTaskWorkBranch,
  findWorkBranchCollisions,
  workBranchCollisionGuard,
} = require('../../scripts/lib/dispatch-guards.js');

// ── matchesTaskWorkBranch: the id-sanitization fix ─────────────────────────

test('matchesTaskWorkBranch: matches a Linear job branch despite the ledger taskId carrying a colon the branch could never contain', () => {
  // gitSafeJobId('linear:BRO-278') -> 'linear-BRO-278', so the real branch
  // bsc-runner.js provisions is job/linear-BRO-278-<suffix> — verified
  // against this session's own worktree (job/linear-BRO-278-mtaf33qe).
  assert.ok(matchesTaskWorkBranch('job/linear-BRO-278-mtaf33qe', 'linear:BRO-278'));
});

test('matchesTaskWorkBranch: matches regardless of which session\'s random suffix the branch carries', () => {
  // The exact incident shape: two DIFFERENT sessions on the SAME Linear
  // issue never produce identical branch names (each gets its own
  // Date.now().toString(36)-based suffix), so a name-equality check would
  // miss the collision. The id-anchored match must still catch it.
  assert.ok(matchesTaskWorkBranch('job/linear-BRO-278-mtaf33qe', 'linear:BRO-278'));
  assert.ok(matchesTaskWorkBranch('job/linear-BRO-278-mt9k2z01', 'linear:BRO-278'));
});

test('matchesTaskWorkBranch: does not false-positive on a numeric-prefix-substring Linear issue id', () => {
  // BRO-27 must never match a BRO-278 branch just because "BRO-27" is a
  // literal prefix of "BRO-278" — same anchoring guarantee the original
  // numeric-id guard already had (a trailing "-" must follow the id).
  assert.ok(!matchesTaskWorkBranch('job/linear-BRO-278-mtaf33qe', 'linear:BRO-27'));
});

test('matchesTaskWorkBranch: does not match a different Linear issue whose id contains this one as a substring', () => {
  assert.ok(!matchesTaskWorkBranch('job/linear-BRO-2780-mtaf33qe', 'linear:BRO-278'));
});

test('matchesTaskWorkBranch: bsc-next.js\'s plain numeric task ids are unaffected (gitSafeJobId is a no-op on digits)', () => {
  assert.ok(matchesTaskWorkBranch('worktree-1233-infra-death-cap', 1233));
  assert.ok(matchesTaskWorkBranch('job/1233-msp9eki9', 1233));
  assert.ok(!matchesTaskWorkBranch('worktree-1233-infra-death-cap', 123));
});

// ── end-to-end: the actual cross-session collision scenario ────────────────

test('findWorkBranchCollisions: two different sessions\' branches for the same Linear issue both surface as collisions', () => {
  const branchStatuses = [
    // Session A's branch — already has unlanded work.
    { name: 'job/linear-BRO-278-mtaf33qe', unlandedCommits: ['abc1234 wip: reconciliation sweep'] },
    // Session B's branch — a DIFFERENT random suffix, same issue, also unlanded.
    { name: 'job/linear-BRO-278-mt9k2z01', unlandedCommits: ['def5678 wip: component inventory'] },
    // An unrelated issue's branch must never be pulled in.
    { name: 'job/linear-BRO-999-mtzz0000', unlandedCommits: ['fff0000 unrelated work'] },
  ];
  const collisions = findWorkBranchCollisions('linear:BRO-278', branchStatuses);
  assert.equal(collisions.length, 2);
  assert.deepEqual(collisions.map((c) => c.name).sort(), [
    'job/linear-BRO-278-mt9k2z01',
    'job/linear-BRO-278-mtaf33qe',
  ]);
});

test('workBranchCollisionGuard: refuses a THIRD dispatch of a Linear issue two other sessions are already working — the actual BRO-278 incident shape', () => {
  const pseudoTask = { id: 'linear:BRO-278', subject: 'BRO-278 Duplicate-dispatch guard misses same-task collisions across sessions' };
  const branchStatuses = [
    { name: 'job/linear-BRO-278-mtaf33qe', unlandedCommits: ['abc1234 wip: reconciliation sweep'] },
    { name: 'job/linear-BRO-278-mt9k2z01', unlandedCommits: ['def5678 wip: component inventory'] },
  ];
  const refusal = workBranchCollisionGuard(pseudoTask, branchStatuses, {});
  assert.ok(refusal, 'a third dispatch onto an already-worked Linear issue must be refused');
  assert.match(refusal, /linear:BRO-278/);
  assert.match(refusal, /job\/linear-BRO-278-mtaf33qe/);
  assert.match(refusal, /job\/linear-BRO-278-mt9k2z01/);
});

test('workBranchCollisionGuard: silent for a Linear issue with no prior unlanded branches (first dispatch)', () => {
  const pseudoTask = { id: 'linear:BRO-999', subject: 'Some other issue' };
  assert.equal(workBranchCollisionGuard(pseudoTask, [], {}), null);
});

test('workBranchCollisionGuard: --force still bypasses the Linear-issue collision, matching bsc-next.js\'s existing escape hatch', () => {
  const pseudoTask = { id: 'linear:BRO-278', subject: 'BRO-278 issue' };
  const branchStatuses = [{ name: 'job/linear-BRO-278-mtaf33qe', unlandedCommits: ['abc1234 wip'] }];
  assert.equal(workBranchCollisionGuard(pseudoTask, branchStatuses, { force: true }), null);
});

test('workBranchCollisionGuard: a Linear issue\'s branch with zero unlanded commits (already merged) is not a collision', () => {
  const pseudoTask = { id: 'linear:BRO-278', subject: 'BRO-278 issue' };
  const branchStatuses = [{ name: 'job/linear-BRO-278-mtaf33qe', unlandedCommits: [] }];
  assert.equal(workBranchCollisionGuard(pseudoTask, branchStatuses, {}), null);
});
