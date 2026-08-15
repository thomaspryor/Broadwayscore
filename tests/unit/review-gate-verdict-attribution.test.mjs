// tests/unit/review-gate-verdict-attribution.test.mjs — BRO-143 ("Pre-push
// review gate: branch-scoped verdicts don't survive a merge into main
// (residual #828 gap)").
//
// Incident (Notion 3b1637c5, observed 2026-08-03 04:05 on task #902): local
// main held two independently ship-checked worktree merges — 902's own merge
// (a2e2ab167f4, verdict 03:48:33, 1197 gated lines) AND 901's already-landed
// merge (35090088fd6, verdict 03:44:16, 1589 lines). Pushing reported "2793
// unreviewed code lines (stale verdict ... 1204 gated lines changed since >
// drift budget 150)" naming 901's files — even though BOTH had passed
// ship-check. The only exit was a NO-SHIP-CHECK bypass, which is exactly the
// behaviour task #828 was closed to stop training sessions into using.
//
// #828 fixed the shared-checkout diff SCOPING (review-gate-scope.test.mjs):
// a small pushing branch's diff no longer gets inflated by an unrelated
// already-merged branch sitting ahead of it on local main. This file locks
// in the adjacent case the card named "verdict ATTRIBUTION across a merge":
// scoping must also hold when EVERY branch on local main is itself large
// (>budget) and independently reviewed, not just when the other branch is
// small enough to fall under GATE_LINE_BUDGET on its own.
//
// By the time this test was written, ownMergeParent() (this file's own-merge
// scoping, used by gatedDiffStats/computeDiffHash for every push-gate query)
// plus the merge gate (task #1304, pre-merge-review-gate.sh) already close
// this residual case as a side effect: ownMergeParent isolates a push's diff
// to only its OWN nearest merge (so an earlier, already-merged branch's
// content never re-enters the diff regardless of size), and the merge gate
// independently verifies each branch's own diff at merge time before it can
// land on shared local main at all — so an unreviewed branch can never hide
// under a later reviewed one's scope. These tests are the acceptance
// criteria from the Notion card, run directly against both gates to prove
// (and lock in) that combination.
//
// Scope: this closes the incident's actual shape — the documented, sequential
// merge-worktree-to-main.sh / wrapper-driven flow. Two gaps ownMergeParent()
// and the merge gate do NOT cover, both already noted at their own
// definitions rather than repeated here, remain open: an octopus merge
// (`git merge branch-a branch-b` in one commit — ownMergeParent bails to the
// unscoped diff on >2 parents) and scripts/autonomous-merge.js's `--ff-only`
// merges (bypass the merge-gate hook entirely by construction, review-gate.mjs
// KNOWN GAP comment above queryMergeAllowed).

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GATE_LINE_BUDGET,
  recordVerdict,
  queryPushAllowed,
  queryMergeAllowed,
} from '../../scripts/lib/review-gate.mjs';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'review-gate-attribution-test-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'base.js'), 'console.log(1);\n');
  // Real repos gitignore the ledger; without this, recordVerdict's untracked
  // .claude/review-verdicts.jsonl gets swept into the next `git add -A` a
  // fixture branch does and turns into a tracked file mid-test.
  writeFileSync(join(repo, '.gitignore'), '.claude/review-verdicts.jsonl\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
}

function commitLines(repo, relPath, nLines, msg) {
  const dir = join(repo, relPath.split('/').slice(0, -1).join('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(repo, relPath),
    Array.from({ length: nLines }, (_, i) => `console.log(${i}); // ${msg}`).join('\n') + '\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
}

// Two sessions, each unaware of the other: both branch off origin/main, both
// run ship-check (recording a verdict) on their OWN branch before merging,
// both comfortably over GATE_LINE_BUDGET. session901 merges first onto
// shared local main, then session902 merges on top and is the one pushing —
// matching the incident's shape exactly.
function twoLargeIndependentlyReviewedBranches(repo) {
  git(repo, 'checkout', '-q', '-b', 'worktree-901', 'refs/remotes/origin/main');
  commitLines(repo, 'scripts/s901.js', GATE_LINE_BUDGET * 5, 'session901 work');
  const v901 = recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'pass' });

  git(repo, 'checkout', '-q', '-b', 'worktree-902', 'refs/remotes/origin/main');
  commitLines(repo, 'scripts/s902.js', GATE_LINE_BUDGET * 7, 'session902 work');
  const v902 = recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'pass' });

  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge worktree-901', 'worktree-901');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge worktree-902', 'worktree-902');

  return { v901, v902 };
}

test('ACCEPTANCE (BRO-143): a main containing two merged branches, each with its own recorded pass verdict, pushes WITHOUT a bypass', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const { v901, v902 } = twoLargeIndependentlyReviewedBranches(repo);
  assert.equal(v901.recorded, true);
  assert.equal(v902.recorded, true);

  const result = queryPushAllowed({ repoRoot: repo, ref: 'HEAD' });
  assert.equal(result.allowed, true, JSON.stringify(result));
  // Scoped to only the last-merged branch's own contribution — not the
  // combined 901+902 total the pre-fix incident reported (2793 lines).
  assert.equal(result.gatedLines, GATE_LINE_BUDGET * 7, JSON.stringify(result));
});

test('ACCEPTANCE (BRO-143): an unreviewed commit merged into main still BLOCKS the push, even sitting on top of a reviewed one', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  git(repo, 'checkout', '-q', '-b', 'worktree-901', 'refs/remotes/origin/main');
  commitLines(repo, 'scripts/s901.js', GATE_LINE_BUDGET * 5, 'session901 work');
  recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'pass' });

  git(repo, 'checkout', '-q', '-b', 'worktree-902', 'refs/remotes/origin/main');
  commitLines(repo, 'scripts/s902.js', GATE_LINE_BUDGET * 7, 'session902 work — NEVER ship-checked');
  // No recordVerdict for 902.

  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge worktree-901', 'worktree-901');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge worktree-902', 'worktree-902');

  const result = queryPushAllowed({ repoRoot: repo, ref: 'HEAD' });
  assert.equal(result.allowed, false, JSON.stringify(result));
  assert.deepEqual(result.gatedFiles, ['scripts/s902.js'], JSON.stringify(result));
});

test('ACCEPTANCE (BRO-143): the merge gate independently verifies each branch at merge time, so an unreviewed branch can never hide under a later reviewed one', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  git(repo, 'checkout', '-q', '-b', 'worktree-901', 'refs/remotes/origin/main');
  commitLines(repo, 'scripts/s901.js', GATE_LINE_BUDGET * 5, 'session901 work — never ship-checked');
  const blocked = queryMergeAllowed({ repoRoot: repo, sources: ['worktree-901'] });
  assert.equal(blocked.allowed, false, JSON.stringify(blocked));

  const rec = recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'pass' });
  assert.equal(rec.recorded, true);
  const allowed = queryMergeAllowed({ repoRoot: repo, sources: ['worktree-901'] });
  assert.equal(allowed.allowed, true, JSON.stringify(allowed));
});

test('node scripts/lib/review-gate.mjs --query=record behaviour unchanged for the single-branch path (BRO-143 acceptance criterion 3)', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'checkout', '-q', '-b', 'solo-branch', 'refs/remotes/origin/main');
  commitLines(repo, 'scripts/solo.js', GATE_LINE_BUDGET * 3, 'solo session work');
  const rec = recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'pass' });
  assert.equal(rec.recorded, true);
  assert.equal(rec.entry.gatedLines, GATE_LINE_BUDGET * 3);

  const beforeMerge = queryPushAllowed({ repoRoot: repo, ref: 'HEAD' });
  assert.equal(beforeMerge.allowed, true, JSON.stringify(beforeMerge));
  assert.equal(beforeMerge.via, 'exact-hash', JSON.stringify(beforeMerge));

  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge solo-branch', 'solo-branch');
  const afterMerge = queryPushAllowed({ repoRoot: repo, ref: 'HEAD' });
  assert.equal(afterMerge.allowed, true, JSON.stringify(afterMerge));
  assert.equal(afterMerge.via, 'exact-hash', JSON.stringify(afterMerge));
});
