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
  landBranch, defaultPushMain, firstFailedCheck, classifyPushFailure, shouldRetry, isPlausibleBranchName, formatLandLine, MAX_ATTEMPTS,
  isInertForVerification, classifyIntervening, decideVerifiedBaseSkip, makeVerifiedBaseChecks,
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
  // "Another session" lands something on origin/main. Default: a substantive
  // (root-level .js) change; pass a path to simulate bot data churn.
  let n = 0;
  const moveOrigin = (file = null) => {
    sh(other, ['fetch', '-q', 'origin', 'main']);
    sh(other, ['reset', '-q', '--hard', 'origin/main']);
    n++;
    commitOn(other, file || `other-${n}.js`, `// ${n}\n`, `other session ${n}`);
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

test('firstFailedCheck picks the first non-passing result and fails closed on a missing pass field', () => {
  assert.equal(firstFailedCheck([]), null);
  assert.equal(firstFailedCheck(null), null);
  assert.equal(firstFailedCheck([{ name: 'a', pass: true }]), null);
  assert.equal(firstFailedCheck([{ name: 'a', pass: true }, { name: 'b', pass: false }, { name: 'c', pass: false }]).name, 'b');
  assert.equal(firstFailedCheck([{ name: 'a', pass: true }, { name: 'no-pass-field' }]).name, 'no-pass-field');
  assert.equal(firstFailedCheck([{ name: 'a', pass: true }, null]).name, 'malformed-check');
});

test('classifyPushFailure: only a moved origin/main is a race', () => {
  assert.equal(classifyPushFailure({ baseSha: 'a', nowBase: 'b' }), 'race');
  assert.equal(classifyPushFailure({ baseSha: 'a', nowBase: 'a' }), 'rejected');
  assert.equal(classifyPushFailure({ baseSha: 'a', nowBase: null }), 'rejected');
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

test('isInertForVerification / classifyIntervening: bot data churn is inert, code is substantive', () => {
  for (const f of ['data/audit/stage-latency.jsonl', 'data/audit/x.json', 'public/data/shows/a.json', 'memory/foo.md', 'README.md', 'cloud-memory/MEMORY.md']) {
    assert.equal(isInertForVerification(f), true, f);
  }
  for (const f of ['scripts/lib/x.js', 'src/app/page.tsx', '.github/workflows/test.yml', 'package.json', 'scripts/x.sh', 'tests/unit/a.test.mjs']) {
    assert.equal(isInertForVerification(f), false, f);
  }
  assert.equal(classifyIntervening(['data/audit/a.json', 'memory/b.md']), 'inert');
  assert.equal(classifyIntervening(['data/audit/a.json', 'scripts/lib/x.js']), 'substantive');
  assert.equal(classifyIntervening([]), 'substantive', 'an empty intervening set is never "inert" — nothing to fast-forward across');
});

test('origin/main moves across INERT paths only during the checks → rebased over, verdict kept, no re-check, lands in one attempt', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-churn');
    let checkRuns = 0; let pushCalls = 0; const logs = [];
    const r = landBranch({
      branch: 'feat-churn', repoDir: w.repoDir, log: (m) => logs.push(m),
      checks: ({ cwd }) => {
        checkRuns++;
        // Real checks leave residue behind (tests write data/audit/*.json);
        // the churn re-rebase must survive it exactly as the retry path does.
        fs.writeFileSync(path.join(cwd, 'a.txt'), 'residue\n');
        w.moveOrigin('data/audit/telemetry.json'); w.moveOrigin('memory/note.md');
        return greenChecks();
      },
      pushMain: (o) => { pushCalls++; plainPush(o); },
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.attempts, 1);
    assert.equal(checkRuns, 1, 'inert churn never re-runs the checks');
    assert.ok(logs.some(l => /churn re-rebase\): discarding 1 check-residue/.test(l)), logs.join('\n'));
    assert.equal(sh(w.repoDir, ['show', `${r.sha}:a.txt`]), 'a', 'residue never lands');
    assert.equal(pushCalls, 1);
    assert.equal(r.churnSkips, 1, 'both churn commits were on origin by the time of one fetch');
    assert.notEqual(r.baseSha, r.verifiedBase, 'the landed base is past the verified base');
    assert.equal(sh(w.repoDir, ['rev-parse', `${r.sha}^`]), r.baseSha, 'the pushed commit sits directly on the churned tip');
    assert.equal(w.originMain(), r.sha);
    assert.ok(logs.some(l => /inert path\(s\) only/.test(l)));
    assert.equal(w.branchSha('feat-churn'), tip);
  } finally { w.cleanup(); }
});

test('origin/main moves across a SUBSTANTIVE path during the checks → full re-check (existing behavior kept)', () => {
  const w = makeWorld();
  try {
    w.makeBranch('feat-subst');
    let checkRuns = 0;
    const r = landBranch({
      branch: 'feat-subst', repoDir: w.repoDir,
      checks: () => { checkRuns++; if (checkRuns === 1) { w.moveOrigin('data/audit/a.json'); w.moveOrigin('scripts/lib/other.js'); } return greenChecks(); },
      pushMain: plainPush,
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.attempts, 2);
    assert.equal(checkRuns, 2, 'one inert + one substantive intervening file → substantive → re-check');
  } finally { w.cleanup(); }
});

test('beforePush receives the base the commit will actually sit on, after the churn re-rebase', () => {
  const w = makeWorld();
  try {
    w.makeBranch('feat-base');
    const seen = [];
    const r = landBranch({
      branch: 'feat-base', repoDir: w.repoDir,
      checks: () => { w.moveOrigin('data/audit/z.json'); return greenChecks(); },
      beforePush: ({ baseSha, verifiedBase }) => seen.push({ baseSha, verifiedBase }),
      pushMain: plainPush,
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].baseSha, sh(w.repoDir, ['rev-parse', `${r.sha}^`]));
    assert.equal(seen[0].verifiedBase, r.verifiedBase);
    assert.notEqual(seen[0].baseSha, seen[0].verifiedBase);
  } finally { w.cleanup(); }
});

test('the churn budget is bounded: past maxChurnSkips a further inert move forces a re-check', () => {
  const w = makeWorld();
  try {
    w.makeBranch('feat-budget');
    let checkRuns = 0; let pushes = 0;
    const r = landBranch({
      branch: 'feat-budget', repoDir: w.repoDir, maxChurnSkips: 1,
      checks: () => { checkRuns++; if (checkRuns === 1) w.moveOrigin('data/a.json'); return greenChecks(); },
      // First push attempt: churn arrives again right before the push (the skip budget is already spent) → rejected → race → attempt 2.
      pushMain: (o) => { pushes++; if (pushes === 1) w.moveOrigin('data/b.json'); plainPush(o); },
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.attempts, 2);
    assert.equal(checkRuns, 2);
  } finally { w.cleanup(); }
});

test('checks that dirty the throwaway tree (tracked edit + untracked file) do not break the retry rebase', () => {
  const w = makeWorld();
  try {
    w.makeBranch('feat-dirty');
    let checkRuns = 0;
    const discards = [];
    const r = landBranch({
      branch: 'feat-dirty', repoDir: w.repoDir,
      log: (m) => { if (/discarding/.test(m)) discards.push(m); },
      checks: ({ cwd }) => {
        checkRuns++;
        fs.writeFileSync(path.join(cwd, 'a.txt'), 'dirtied by a test\n');       // tracked file modified
        fs.writeFileSync(path.join(cwd, 'residue.json'), '{}\n');               // untracked residue
        if (checkRuns === 1) w.moveOrigin();                                    // force attempt 2
        return greenChecks();
      },
      pushMain: plainPush,
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.attempts, 2);
    assert.equal(discards.length, 1, 'the residue is discarded exactly once, before the retry, and logged');
    assert.match(discards[0], /a\.txt/);
    // What landed is the branch's own content, never the residue.
    assert.equal(sh(w.repoDir, ['show', `${r.sha}:a.txt`]), 'a');
    assert.throws(() => sh(w.repoDir, ['cat-file', '-e', `${r.sha}:residue.json`]));
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
    assert.equal(r.failedCheck, 'race');
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

test('already-ancestor whose files were later reverted on main → landed, but with a content note (never silent)', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-reverted');
    sh(w.repoDir, ['push', '-q', 'origin', 'feat-reverted:main']);
    // Someone reverts it on main.
    sh(w.other, ['fetch', '-q', 'origin', 'main']);
    sh(w.other, ['reset', '-q', '--hard', 'origin/main']);
    sh(w.other, ['revert', '--no-edit', 'HEAD']);
    sh(w.other, ['push', '-q', 'origin', 'HEAD:main']);
    const r = landBranch({ branch: 'feat-reverted', repoDir: w.repoDir, checks: greenChecks, pushMain: () => { throw new Error('no push expected'); } });
    assert.equal(r.landed, true);
    assert.equal(r.pushed, false);
    assert.equal(r.sha, tip);
    assert.match(r.contentNote, /1 of the tip commit's 1 file\(s\) have since changed on origin\/main: feature\.txt/);
    assert.match(formatLandLine('feat-reverted', r), /already on origin\/main, no push; 1 of the tip commit's/);
    // Control: the plain already-landed case carries no note.
    const tip2 = w.makeBranch('feat-plain');
    sh(w.repoDir, ['push', '-q', 'origin', 'feat-plain:main']);
    const r2 = landBranch({ branch: 'feat-plain', repoDir: w.repoDir, checks: greenChecks, pushMain: () => { throw new Error('no push expected'); } });
    assert.equal(r2.sha, tip2);
    assert.equal(r2.contentNote, null);
  } finally { w.cleanup(); }
});

test('a push seam that replays HEAD (push-with-retry-style rebase) violates the contract → refused as push-contract', () => {
  const w = makeWorld();
  try {
    w.makeBranch('feat-replay');
    const r = landBranch({
      branch: 'feat-replay', repoDir: w.repoDir, checks: greenChecks,
      pushMain: ({ cwd }) => {
        // What push-with-retry.sh does on a rejection: fetch, rebase onto the
        // newer tip, push again — behind the checks' back.
        w.moveOrigin();
        sh(cwd, ['fetch', '-q', 'origin', 'main']);
        sh(cwd, ['rebase', '-q', 'origin/main']);
        sh(cwd, ['push', '-q', 'origin', 'HEAD:main']);
      },
    });
    assert.equal(r.landed, false);
    assert.equal(r.failedCheck, 'push-contract');
    assert.match(r.reason, /moved HEAD/);
  } finally { w.cleanup(); }
});

test('the default push seam is push-only: a rejection throws, nothing is rebased or merged behind the checks', () => {
  const w = makeWorld();
  try {
    w.makeBranch('feat-default-push');
    let pushCalls = 0;
    const r = landBranch({
      branch: 'feat-default-push', repoDir: w.repoDir, checks: greenChecks,
      pushMain: (o) => { pushCalls++; if (pushCalls === 1) w.moveOrigin(); defaultPushMain(o); },
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.attempts, 2, 'the first (real) push was rejected non-ff and surfaced as a retry, not replayed');
    assert.equal(pushCalls, 2);
    assert.equal(w.originMain(), r.sha);
  } finally { w.cleanup(); }
});

test('a push failure while origin/main did NOT move (hook block, auth) is refused at once, not retried as a race', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-hook');
    let pushCalls = 0; let checkRuns = 0;
    const r = landBranch({
      branch: 'feat-hook', repoDir: w.repoDir,
      checks: () => { checkRuns++; return greenChecks(); },
      pushMain: () => { pushCalls++; const e = new Error('hook'); e.stderr = '\n=== PRE-PUSH BLOCKED: orphan-tests failed ===\nerror: failed to push some refs\n'; throw e; },
    });
    assert.equal(r.landed, false);
    assert.equal(r.failedCheck, 'push');
    assert.equal(r.attempts, 1);
    assert.equal(pushCalls, 1, 'no retry when nothing moved');
    assert.equal(checkRuns, 1);
    assert.match(r.reason, /^pre-push hook: orphan-tests failed/);
    assert.equal(w.branchSha('feat-hook'), tip);
    assert.equal(w.isAncestorOfOrigin(tip), false);
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

// ── verified-base seam + expectSha (land.yml, BRO-3873 step 3) ──────────────

test('decideVerifiedBaseSkip: skip only on the verified base or an inert-only move past it; fails closed otherwise', () => {
  const v = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  assert.equal(decideVerifiedBaseSkip({ verifiedBase: v, baseSha: v, ancestor: true, intervening: [] }).skip, true);
  assert.equal(decideVerifiedBaseSkip({ verifiedBase: v, baseSha: b, ancestor: true, intervening: ['data/audit/x.json', 'memory/y.md'] }).skip, true);
  assert.equal(decideVerifiedBaseSkip({ verifiedBase: v, baseSha: b, ancestor: true, intervening: ['scripts/lib/z.js'] }).skip, false);
  assert.equal(decideVerifiedBaseSkip({ verifiedBase: v, baseSha: b, ancestor: true, intervening: [] }).skip, false, 'a move with no diff is not proven inert');
  assert.equal(decideVerifiedBaseSkip({ verifiedBase: v, baseSha: b, ancestor: false, intervening: ['memory/y.md'] }).skip, false, 'non-ancestor never skips');
  assert.equal(decideVerifiedBaseSkip({ verifiedBase: v, baseSha: b, ancestor: null, intervening: ['memory/y.md'] }).skip, false, 'unknown ancestry never skips');
  assert.equal(decideVerifiedBaseSkip({ verifiedBase: null, baseSha: b, ancestor: true, intervening: [] }).skip, false);
});

test('makeVerifiedBaseChecks: reuses the verdict (and still prepares the worktree) on the skip path, runs the real checks otherwise', () => {
  const v = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  assert.throws(() => makeVerifiedBaseChecks({ verifiedBase: 'short' }), /40-hex/);
  const calls = [];
  const fakeGit = (moved, files) => (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'merge-base') return moved === 'not-ancestor' ? null : '';
    if (args[0] === 'diff') return files.join('\n');
    return '';
  };
  const prepared = [];
  const inner = (o) => [{ name: 'inner-ran', pass: true, detail: o.baseSha }];

  // Same base → skip, prepare called, inner never runs.
  let checks = makeVerifiedBaseChecks({ verifiedBase: v, checks: inner, git: fakeGit('same', []), prepare: (cwd, repo) => { prepared.push([cwd, repo]); return ['node_modules']; } });
  let out = checks({ cwd: '/wt', baseSha: v, repoDir: '/repo', changedFiles: ['x.js'] });
  assert.deepEqual(out.map(r => r.name), ['verified-upstream']);
  assert.equal(out[0].pass, true);
  assert.deepEqual(prepared, [['/wt', '/repo']]);

  // Inert move → skip.
  checks = makeVerifiedBaseChecks({ verifiedBase: v, checks: inner, git: fakeGit('inert', ['data/audit/ledger.jsonl', 'public/data/x.json']), prepare: () => [] });
  out = checks({ cwd: '/wt', baseSha: b, repoDir: '/repo' });
  assert.deepEqual(out.map(r => r.name), ['verified-upstream']);

  // Substantive move → the real checks run against the new base.
  checks = makeVerifiedBaseChecks({ verifiedBase: v, checks: inner, git: fakeGit('subst', ['scripts/lib/land-branch.js']), prepare: () => [] });
  out = checks({ cwd: '/wt', baseSha: b, repoDir: '/repo' });
  assert.deepEqual(out, [{ name: 'inner-ran', pass: true, detail: b }]);

  // Not an ancestor (force-moved main, wrong sha) → real checks, never a skip.
  checks = makeVerifiedBaseChecks({ verifiedBase: v, checks: inner, git: fakeGit('not-ancestor', ['memory/x.md']), prepare: () => [] });
  out = checks({ cwd: '/wt', baseSha: b, repoDir: '/repo' });
  assert.deepEqual(out.map(r => r.name), ['inner-ran']);
});

test('expectSha: a branch whose tip moved since verification is refused before any worktree or push', () => {
  const w = makeWorld();
  try {
    const verifiedTip = w.makeBranch('feat-moved');
    // The branch moves on after "verification".
    const wt = path.join(w.root, 'wt-moved');
    sh(w.repoDir, ['worktree', 'add', '-q', wt, 'feat-moved']);
    const newTip = w.commitOn(wt, 'later.txt', 'later\n', 'a later push');
    sh(w.repoDir, ['worktree', 'remove', '--force', wt]);
    assert.notEqual(newTip, verifiedTip);
    const r = landBranch({ branch: 'feat-moved', repoDir: w.repoDir, expectSha: verifiedTip, checks: greenChecks, pushMain: plainPush });
    assert.equal(r.landed, false);
    assert.equal(r.failedCheck, 'resolve');
    assert.match(r.reason, /not the verified tip/);
    assert.equal(w.isAncestorOfOrigin(newTip), false, 'nothing may be pushed');
    assert.equal(w.worktreeCount(), 1, 'no throwaway worktree left behind');
    // Same call with the CURRENT tip lands normally.
    const ok = landBranch({ branch: 'feat-moved', repoDir: w.repoDir, expectSha: newTip, checks: greenChecks, pushMain: plainPush });
    assert.equal(ok.landed, true, JSON.stringify(ok));
  } finally { w.cleanup(); }
});

test('verified-base seam end-to-end: gauntlet skipped on the verified base, run again after a substantive move', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-vb');
    const verifiedBase = w.originMain();
    let innerRuns = 0;
    const inner = () => { innerRuns++; return [{ name: 'inner', pass: true }]; };
    const r1 = landBranch({ branch: 'feat-vb', repoDir: w.repoDir, dryRun: true, checks: makeVerifiedBaseChecks({ verifiedBase, checks: inner, prepare: () => [] }), pushMain: plainPush });
    assert.equal(r1.dryRun, true, JSON.stringify(r1));
    assert.equal(innerRuns, 0, 'gauntlet must be skipped on the verified base');
    // Substantive move on main since verification → the gauntlet runs.
    w.moveOrigin('scripts/other.js');
    const r2 = landBranch({ branch: 'feat-vb', repoDir: w.repoDir, checks: makeVerifiedBaseChecks({ verifiedBase, checks: inner, prepare: () => [] }), pushMain: plainPush });
    assert.equal(r2.landed, true, JSON.stringify(r2));
    assert.equal(innerRuns, 1, 'gauntlet must run after a substantive move');
    assert.ok(w.isAncestorOfOrigin(r2.sha));
    void tip;
  } finally { w.cleanup(); }
});
