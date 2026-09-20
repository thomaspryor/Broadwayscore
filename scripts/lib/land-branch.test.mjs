/**
 * land-branch.test.mjs — drives the REAL landBranch() (rule 15: require(),
 * never a copy) against throwaway git repos: a bare "origin", a clone that
 * plays the shared checkout (repoDir), and a second clone that plays "some
 * other session" pushing to main underneath us. The expensive seams (the
 * check gauntlet, the push primitive) are faked; every git operation the lib
 * performs — fetch, detached worktree, rebase, diff, ancestry, cleanup — is
 * real.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  landBranch, firstFailedCheck, shouldRetry, isPlausibleBranchName, formatLandLine, MAX_ATTEMPTS,
} = require('./land-branch.js');

// The lib's landing-verify call would try `git fetch --unshallow` only on a
// shallow repo; these repos are full clones, so no env juggling is needed.

function sh(cwd, args, extra = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...extra }).trim();
}

/** origin (bare, branch main) + repoDir clone + "other session" clone. */
function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'land-branch-test-'));
  const origin = path.join(root, 'origin.git');
  sh(root, ['init', '-q', '--bare', '--initial-branch=main', origin]);

  const seed = path.join(root, 'seed');
  sh(root, ['clone', '-q', origin, seed]);
  const cfg = (dir) => { sh(dir, ['config', 'user.email', 't@e.st']); sh(dir, ['config', 'user.name', 'test']); };
  cfg(seed);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n');
  fs.mkdirSync(path.join(seed, 'scripts'));
  fs.writeFileSync(path.join(seed, 'scripts', 'x.js'), 'module.exports = 1;\n');
  sh(seed, ['add', '.']);
  sh(seed, ['commit', '-qm', 'base']);
  sh(seed, ['push', '-q', 'origin', 'HEAD:main']);

  const repoDir = path.join(root, 'repo');
  sh(root, ['clone', '-q', origin, repoDir]);
  cfg(repoDir);
  const other = path.join(root, 'other');
  sh(root, ['clone', '-q', origin, other]);
  cfg(other);

  const commitOn = (dir, file, content, msg) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
    sh(dir, ['add', file]);
    sh(dir, ['commit', '-qm', msg]);
    return sh(dir, ['rev-parse', 'HEAD']);
  };
  // "Another session" lands something on origin/main.
  let n = 0;
  const moveOrigin = () => {
    sh(other, ['fetch', '-q', 'origin', 'main']);
    sh(other, ['reset', '-q', '--hard', 'origin/main']);
    commitOn(other, `other-${++n}.txt`, `${n}\n`, `other session ${n}`);
    sh(other, ['push', '-q', 'origin', 'HEAD:main']);
    return sh(other, ['rev-parse', 'HEAD']);
  };
  // A feature branch in repoDir, forked from the current origin/main.
  const makeBranch = (name, file = 'feature.txt', content = 'feature\n') => {
    sh(repoDir, ['fetch', '-q', 'origin', 'main']);
    sh(repoDir, ['branch', '-q', name, 'origin/main']);
    const wt = path.join(root, `wt-${name}`);
    sh(repoDir, ['worktree', 'add', '-q', wt, name]);
    const sha = commitOn(wt, file, content, `feat: ${name}`);
    sh(repoDir, ['worktree', 'remove', '--force', wt]);
    return sha;
  };
  const originMain = () => sh(other, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
  const branchSha = (name) => sh(repoDir, ['rev-parse', name]);
  const isAncestorOfOrigin = (sha) => {
    sh(repoDir, ['fetch', '-q', 'origin', 'main']);
    try { sh(repoDir, ['merge-base', '--is-ancestor', sha, 'origin/main']); return true; } catch { return false; }
  };
  const worktreeCount = () => sh(repoDir, ['worktree', 'list', '--porcelain']).split('\n').filter(l => l.startsWith('worktree ')).length;
  const cleanup = () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } };
  return { root, origin, repoDir, other, commitOn, moveOrigin, makeBranch, originMain, branchSha, isAncestorOfOrigin, worktreeCount, cleanup };
}

const greenChecks = () => [{ name: 'fake-green', pass: true }];
const redChecks = () => [{ name: 'fake-red', pass: false, detail: 'boom' }];
/** A plain fast-forward push from the lib's workdir — what push-with-retry.sh does on the happy path. */
const plainPush = ({ cwd }) => sh(cwd, ['push', '-q', 'origin', 'HEAD:main']);

// ── pure helpers ────────────────────────────────────────────────────────────

test('firstFailedCheck picks the first red result and ignores green/empty', () => {
  assert.equal(firstFailedCheck([]), null);
  assert.equal(firstFailedCheck(null), null);
  assert.equal(firstFailedCheck([{ name: 'a', pass: true }]), null);
  assert.equal(firstFailedCheck([{ name: 'a', pass: true }, { name: 'b', pass: false }, { name: 'c', pass: false }]).name, 'b');
});

test('shouldRetry is bounded by maxAttempts', () => {
  assert.equal(shouldRetry(1, 3), true);
  assert.equal(shouldRetry(2, 3), true);
  assert.equal(shouldRetry(3, 3), false);
  assert.equal(shouldRetry(MAX_ATTEMPTS, MAX_ATTEMPTS), false);
});

test('isPlausibleBranchName refuses option-like and malformed names', () => {
  assert.equal(isPlausibleBranchName('worktree-bro-3873-land-lib'), true);
  assert.equal(isPlausibleBranchName('auto/foo'), true);
  for (const bad of ['', '--force', '-x', 'a b', 'a..b', 'a~1', 'a^', 'a:b', null, undefined]) {
    assert.equal(isPlausibleBranchName(bad), false, `expected refusal for ${JSON.stringify(bad)}`);
  }
});

test('formatLandLine: LANDED / REFUSED shapes the CLI contract promises', () => {
  const landed = formatLandLine('b', { landed: true, sha: 'abc', attempts: 2, wallMs: 1500, pushed: true });
  assert.equal(landed, 'LANDED: b → abc in 1.5s (attempts 2)');
  const refused = formatLandLine('b', { landed: false, failedCheck: 'tsc', reason: 'TS2307', attempts: 1, wallMs: 200 });
  assert.match(refused, /^REFUSED: tsc: TS2307 \(attempts 1, 0\.2s\)$/);
});

// ── the landing itself, real git ────────────────────────────────────────────

test('green checks → landed: sha is an ancestor of origin/main, branch ref untouched, worktree cleaned up', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-green');
    const before = w.worktreeCount();
    const pushes = [];
    const seen = [];
    const r = landBranch({
      branch: 'feat-green', repoDir: w.repoDir,
      checks: (o) => { seen.push(o.changedFiles); return greenChecks(); },
      pushMain: (o) => { pushes.push(o.sha); plainPush(o); },
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.attempts, 1);
    assert.equal(r.pushed, true);
    assert.equal(r.failedCheck, null);
    assert.equal(pushes.length, 1);
    assert.equal(r.sha, tip, 'nothing moved on origin, so the rebase is a no-op and the tip lands as-is');
    assert.equal(w.originMain(), r.sha);
    assert.equal(w.isAncestorOfOrigin(r.sha), true);
    assert.deepEqual(seen, [['feature.txt']], 'checks see the rebased diff');
    assert.equal(w.branchSha('feat-green'), tip, 'the branch ref is never modified');
    assert.equal(w.worktreeCount(), before, 'the throwaway worktree is removed');
    assert.ok(r.wallMs >= 0);
  } finally { w.cleanup(); }
});

test('red check → refused with the failing check named, NO push, branch untouched, worktree cleaned up', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-red');
    const originBefore = w.originMain();
    let pushes = 0;
    const r = landBranch({
      branch: 'feat-red', repoDir: w.repoDir,
      checks: redChecks,
      pushMain: () => { pushes++; },
    });
    assert.equal(r.landed, false);
    assert.equal(r.failedCheck, 'fake-red');
    assert.match(r.reason, /boom/);
    assert.equal(r.attempts, 1);
    assert.equal(pushes, 0, 'a red check must never reach the push');
    assert.equal(w.originMain(), originBefore);
    assert.equal(w.branchSha('feat-red'), tip);
    assert.equal(w.worktreeCount(), 1, 'only the repo checkout itself remains');
  } finally { w.cleanup(); }
});

test('origin/main moved once (push rejected non-ff) → second attempt re-rebases, re-checks and lands', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-race1');
    let checkRuns = 0;
    let pushCalls = 0;
    const r = landBranch({
      branch: 'feat-race1', repoDir: w.repoDir,
      checks: () => { checkRuns++; return greenChecks(); },
      pushMain: (o) => {
        pushCalls++;
        if (pushCalls === 1) w.moveOrigin(); // someone lands between our fetch and our push
        plainPush(o);                        // → rejected (non-fast-forward) the first time
      },
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.attempts, 2);
    assert.equal(checkRuns, 2, 'the retry re-runs the checks on the re-rebased tree');
    assert.equal(pushCalls, 2);
    assert.notEqual(r.sha, tip, 'the landed sha is the REBASED commit, not the original tip');
    assert.equal(w.originMain(), r.sha);
    assert.equal(w.isAncestorOfOrigin(r.sha), true);
    assert.equal(w.branchSha('feat-race1'), tip, 'branch ref untouched even though its commit was rebased for landing');
    // The other session's commit survived: history was never rewritten.
    assert.equal(w.isAncestorOfOrigin(sh(w.other, ['rev-parse', 'HEAD'])), true);
  } finally { w.cleanup(); }
});

test('origin/main moves during the checks (before any push) → detected, re-rebased, then lands', () => {
  const w = makeWorld();
  try {
    w.makeBranch('feat-during');
    let checkRuns = 0;
    let pushCalls = 0;
    const r = landBranch({
      branch: 'feat-during', repoDir: w.repoDir,
      checks: () => { checkRuns++; if (checkRuns === 1) w.moveOrigin(); return greenChecks(); },
      pushMain: (o) => { pushCalls++; plainPush(o); },
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.attempts, 2);
    assert.equal(checkRuns, 2);
    assert.equal(pushCalls, 1, 'a tree verified against a stale base is never pushed');
    assert.equal(w.originMain(), r.sha);
  } finally { w.cleanup(); }
});

test('origin/main moves 4x (every attempt loses) → refused after MAX_ATTEMPTS, nothing landed, no history rewrite', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-race4');
    let pushCalls = 0;
    const r = landBranch({
      branch: 'feat-race4', repoDir: w.repoDir,
      checks: greenChecks,
      pushMain: (o) => { pushCalls++; w.moveOrigin(); plainPush(o); },
    });
    assert.equal(r.landed, false);
    assert.equal(r.failedCheck, 'push');
    assert.equal(r.attempts, MAX_ATTEMPTS);
    assert.equal(pushCalls, MAX_ATTEMPTS, 'bounded: exactly maxAttempts pushes, then stop');
    assert.match(r.reason, /kept moving/);
    assert.equal(w.isAncestorOfOrigin(tip), false, 'the branch never reached main');
    assert.equal(w.branchSha('feat-race4'), tip);
    assert.equal(w.worktreeCount(), 1);
    // All of the other session's commits are intact on origin/main.
    assert.equal(w.isAncestorOfOrigin(sh(w.other, ['rev-parse', 'HEAD'])), true);
  } finally { w.cleanup(); }
});

test('branch tip already an ancestor of origin/main → landed without checks or push (idempotent)', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-done');
    sh(w.repoDir, ['push', '-q', 'origin', 'feat-done:main']); // it's already on main
    let checks = 0; let pushes = 0;
    const r = landBranch({
      branch: 'feat-done', repoDir: w.repoDir,
      checks: () => { checks++; return greenChecks(); },
      pushMain: () => { pushes++; },
    });
    assert.equal(r.landed, true);
    assert.equal(r.pushed, false);
    assert.equal(r.attempts, 0);
    assert.equal(r.sha, tip);
    assert.equal(checks, 0);
    assert.equal(pushes, 0);
    assert.match(formatLandLine('feat-done', r), /^LANDED: .* \(already on origin\/main, no push\)$/);
  } finally { w.cleanup(); }
});

test('branch whose patches already landed under a different sha → rebases to empty, landed without push', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-twin');
    // Same change lands on main via another route (different sha, same patch).
    sh(w.other, ['fetch', '-q', 'origin', 'main']);
    sh(w.other, ['reset', '-q', '--hard', 'origin/main']);
    w.commitOn(w.other, 'feature.txt', 'feature\n', 'same patch, other route');
    sh(w.other, ['push', '-q', 'origin', 'HEAD:main']);
    let pushes = 0;
    const r = landBranch({ branch: 'feat-twin', repoDir: w.repoDir, checks: greenChecks, pushMain: () => { pushes++; } });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.pushed, false);
    assert.equal(pushes, 0);
    assert.equal(r.sha, w.originMain());
    assert.equal(w.branchSha('feat-twin'), tip);
  } finally { w.cleanup(); }
});

test('rebase conflict → refused as "rebase", aborted cleanly, no push', () => {
  const w = makeWorld();
  try {
    w.makeBranch('feat-conflict', 'a.txt', 'branch version\n');
    sh(w.other, ['fetch', '-q', 'origin', 'main']);
    sh(w.other, ['reset', '-q', '--hard', 'origin/main']);
    w.commitOn(w.other, 'a.txt', 'main version\n', 'conflicting edit on main');
    sh(w.other, ['push', '-q', 'origin', 'HEAD:main']);
    let pushes = 0;
    const r = landBranch({ branch: 'feat-conflict', repoDir: w.repoDir, checks: greenChecks, pushMain: () => { pushes++; } });
    assert.equal(r.landed, false);
    assert.equal(r.failedCheck, 'rebase');
    assert.equal(pushes, 0);
    assert.equal(w.worktreeCount(), 1);
  } finally { w.cleanup(); }
});

test('dry-run: rebases and checks, never pushes, reports the would-be sha', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-dry');
    let pushes = 0;
    const r = landBranch({ branch: 'feat-dry', repoDir: w.repoDir, dryRun: true, checks: greenChecks, pushMain: () => { pushes++; } });
    assert.equal(r.landed, false);
    assert.equal(r.dryRun, true);
    assert.equal(r.sha, tip);
    assert.equal(pushes, 0);
    assert.match(r.reason, /dry-run/);
    assert.equal(w.isAncestorOfOrigin(tip), false);
    assert.match(formatLandLine('feat-dry', r), /^DRY-RUN OK: feat-dry → [0-9a-f]{40} checks green/);
  } finally { w.cleanup(); }
});

test('beforePush may amend HEAD (trailer stamping) and the amended sha is what lands', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-stamp');
    const r = landBranch({
      branch: 'feat-stamp', repoDir: w.repoDir, checks: greenChecks, pushMain: plainPush,
      beforePush: ({ git, baseSha }) => {
        const msg = git(['log', '-1', '--pretty=%B']);
        git(['commit', '--amend', '-q', '-m', `${msg}\n\nLand-base: ${baseSha}`]);
      },
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.notEqual(r.sha, tip);
    assert.equal(w.originMain(), r.sha);
    assert.match(sh(w.repoDir, ['log', '-1', '--pretty=%B', r.sha]), /Land-base: [0-9a-f]{40}/);
  } finally { w.cleanup(); }
});

test('unknown branch and unusable names are refused before any worktree is created', () => {
  const w = makeWorld();
  try {
    const before = w.worktreeCount();
    const r1 = landBranch({ branch: 'no-such-branch', repoDir: w.repoDir, checks: greenChecks, pushMain: plainPush });
    assert.equal(r1.landed, false);
    assert.equal(r1.failedCheck, 'resolve');
    const r2 = landBranch({ branch: '--force', repoDir: w.repoDir, checks: greenChecks, pushMain: plainPush });
    assert.equal(r2.failedCheck, 'args');
    const r3 = landBranch({ branch: 'main', repoDir: w.repoDir, checks: greenChecks, pushMain: plainPush });
    assert.equal(r3.failedCheck, 'args');
    assert.equal(w.worktreeCount(), before);
  } finally { w.cleanup(); }
});

test('source: "origin" lands the remote copy of the branch even when no local ref exists', () => {
  const w = makeWorld();
  try {
    // Branch exists only on origin (pushed from the other clone).
    sh(w.other, ['fetch', '-q', 'origin', 'main']);
    sh(w.other, ['reset', '-q', '--hard', 'origin/main']);
    const tip = w.commitOn(w.other, 'remote-only.txt', 'r\n', 'remote-only branch');
    sh(w.other, ['push', '-q', 'origin', 'HEAD:refs/heads/auto/remote-only']);
    const r = landBranch({ branch: 'auto/remote-only', repoDir: w.repoDir, source: 'origin', checks: greenChecks, pushMain: plainPush });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.sha, tip);
    assert.equal(w.originMain(), tip);
  } finally { w.cleanup(); }
});
