// tests/unit/review-gate-scope.test.mjs — task #828.
//
// With ~20 parallel worktree sessions sharing one local `main` checkout
// (only one worktree can have `main` checked out at a time), the documented
// merge pattern `checkout main && pull && merge <branch> && push` serializes
// on that shared checkout — a session's own merge can land on top of OTHER
// sessions' merges already on local main but not yet pushed to origin. The
// gate's diff must scope to what THIS push's merge actually introduces, not
// everything ahead of origin/main (which would include those other
// sessions' unrelated, already-reviewed commits — reported as "unreviewed"
// lines in files the pushing session never touched).

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GATE_LINE_BUDGET,
  gatedDiffStats,
  queryPushAllowed,
  resolveBase,
} from '../../scripts/lib/review-gate.mjs';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'review-gate-scope-test-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'base.js'), 'console.log(1);\n');
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

// Simulates two different sessions' branches landing on the same shared
// local main: sessionA merges first (60 gated lines), then — before
// anything is pushed to origin — sessionB merges its own small branch
// (10 gated lines) on top. sessionB is the one about to push.
function makeSharedMainWithTwoBranches() {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', '-b', 'sessionA-branch');
  commitLines(repo, 'scripts/session-a.js', 60, 'sessionA work');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge sessionA-branch', 'sessionA-branch');

  git(repo, 'checkout', '-q', '-b', 'sessionB-branch');
  commitLines(repo, 'scripts/session-b.js', 10, 'sessionB work');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge sessionB-branch', 'sessionB-branch');
  return repo;
}

test('ACCEPTANCE: gated-line count for a push includes ONLY the pushing branch\'s commits', (t) => {
  const repo = makeSharedMainWithTwoBranches();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const base = resolveBase(repo);
  const stats = gatedDiffStats(repo, base, 'HEAD');
  const paths = stats.files.map(f => f.path);
  assert.deepEqual(paths, ['scripts/session-b.js'], JSON.stringify(stats.files));
  assert.equal(stats.totalLines, 10, JSON.stringify(stats));
});

test('ACCEPTANCE: sessionB\'s small own-diff push is allowed even though shared main also carries sessionA\'s large unrelated merge', (t) => {
  const repo = makeSharedMainWithTwoBranches();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const r = queryPushAllowed({ repoRoot: repo });
  assert.equal(r.allowed, true, JSON.stringify(r));
  assert.equal(r.gated, false, JSON.stringify(r));
  assert.ok(r.gatedLines <= GATE_LINE_BUDGET, JSON.stringify(r));
});

test('without own-merge scoping the naive diff would have wrongly inflated past budget (sanity check on fixture)', (t) => {
  const repo = makeSharedMainWithTwoBranches();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const base = resolveBase(repo);
  // Direct three-dot diff (the pre-fix behavior) conflates both sessions' work.
  const naive = execFileSync('git', ['-C', repo, 'diff', '--numstat', `${base}...HEAD`, '--', 'scripts'], { encoding: 'utf8' });
  const naiveLines = naive.split('\n').filter(Boolean).reduce((n, line) => {
    const m = line.match(/^(\d+)\t(\d+)\t/);
    return m ? n + parseInt(m[1], 10) + parseInt(m[2], 10) : n;
  }, 0);
  assert.ok(naiveLines > GATE_LINE_BUDGET, `fixture should exceed budget pre-fix, got ${naiveLines}`);
});

test('a merge commit whose own branch exceeds budget is still gated (fix does not disable the gate)', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'checkout', '-q', '-b', 'other-session-branch');
  commitLines(repo, 'scripts/other.js', 60, 'other session, already reviewed elsewhere');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge other-session-branch', 'other-session-branch');

  git(repo, 'checkout', '-q', '-b', 'my-branch');
  commitLines(repo, 'scripts/mine.js', 60, 'my own big unreviewed change');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge my-branch', 'my-branch');

  const base = resolveBase(repo);
  const stats = gatedDiffStats(repo, base, 'HEAD');
  assert.deepEqual(stats.files.map(f => f.path), ['scripts/mine.js']);

  const r = queryPushAllowed({ repoRoot: repo });
  assert.equal(r.allowed, false, JSON.stringify(r));
  assert.match(r.reason, /no review verdict/);
});

// Regression (adversarial review, task #828): `git pull origin main` is ALSO
// a 2-parent merge commit — parent1 is the session's own prior HEAD
// (carrying its real unpushed work), parent2 is origin's freshly-fetched
// tip. Naively scoping to parent1..ref there diffs AWAY the session's own
// commits and keeps only origin's incoming delta — exactly backwards. This
// is the exact "push rejected (non-fast-forward) → pull → retry" sequence
// this repo's parallel-session workflow hits constantly.
test('REGRESSION: a git-pull merge (parent2 = origin/main) does not hide the session\'s own commits', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  // Clone BEFORE the session does its own work, so origin can diverge
  // independently (a real `git pull` merge, not a fast-forward) — matching
  // the actual "push rejected because origin moved" → pull → retry sequence.
  const originClone = mkdtempSync(join(tmpdir(), 'review-gate-scope-origin-'));
  git(repo, 'clone', '-q', repo, originClone);
  // `git clone` does not inherit the parent repo's LOCAL config (user.email
  // etc. set in makeRepo() above) — CI runners have no global git identity
  // either, so a commit in originClone fails there even though it passes on
  // a dev machine with a global identity configured.
  git(originClone, 'config', 'user.email', 'test@example.com');
  git(originClone, 'config', 'user.name', 'Test');
  git(originClone, 'config', 'commit.gpgsign', 'false');
  git(repo, 'remote', 'add', 'origin', originClone);
  t.after(() => rmSync(originClone, { recursive: true, force: true }));

  git(repo, 'checkout', '-q', '-b', 'my-branch');
  commitLines(repo, 'scripts/mine.js', 80, 'my own unreviewed work');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge my-branch', 'my-branch');

  // Meanwhile, someone else pushed to the real origin — an independent
  // commit off the ORIGINAL tip, so local main and origin/main have each
  // diverged with their own unique work.
  commitLines(originClone, 'scripts/upstream.js', 5, 'someone else pushed this');

  // `git pull origin main` — a real fetch+merge (parent1 = this session's
  // prior HEAD carrying its 80-line work, parent2 = origin's new tip).
  git(repo, 'fetch', '-q', 'origin', 'main');
  git(repo, 'pull', '-q', '--no-rebase', 'origin', 'main');

  const base = resolveBase(repo);
  const stats = gatedDiffStats(repo, base, 'HEAD');
  const paths = stats.files.map(f => f.path).sort();
  // Must still see the session's own 80-line file — NOT just upstream's 5 lines.
  assert.ok(paths.includes('scripts/mine.js'), JSON.stringify(stats.files));
  assert.ok(stats.totalLines >= 80, JSON.stringify(stats));
});

// Regression: this repo's real main almost never has a merge commit as its
// exact tip — a trailing non-merge commit (e.g. the session-stop "chore:
// sync cloud-memory" auto-commit) routinely lands on top. The scoping must
// walk back through such commits to find the merge that actually bounds
// this push, not silently fall back to the old (conflated) behavior.
test('REGRESSION: scoping survives a trailing non-merge commit on top of the merge (e.g. an auto-commit)', (t) => {
  const repo = makeSharedMainWithTwoBranches();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitLines(repo, 'scripts/session-b-followup.js', 5, 'small trailing commit after the merge');

  const base = resolveBase(repo);
  const stats = gatedDiffStats(repo, base, 'HEAD');
  const paths = stats.files.map(f => f.path).sort();
  assert.deepEqual(paths, ['scripts/session-b-followup.js', 'scripts/session-b.js'], JSON.stringify(stats.files));
  assert.equal(stats.totalLines, 15, JSON.stringify(stats));
});
