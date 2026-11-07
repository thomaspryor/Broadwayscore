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
  landBranch, defaultPushMain, firstFailedCheck, classifyPushFailure, shouldRetry, decideCancelledLandRetry, decideCancelledWait, MAX_CANCEL_RETRIES, isPlausibleBranchName, formatLandLine, MAX_ATTEMPTS,
  isInertForVerification, classifyIntervening, decideVerifiedBaseSkip, makeVerifiedBaseChecks, mergedTreeGateInput, CAPPED_DOCS_TEST,
  selectRecheckScope, selectTrainRecheckScope, isBuildCodePath, isMergeableBothSidesLedger, jsonFileParses,
  isPromisorFetchFailure, isGeneratedDocConflict, DEFAULT_LAND_DEADLINE_MS, landDeadlineMs, deadlineRefusal, checkTimings,
} = require('./land-branch.js');
const { selectTestFiles } = require('./merge-post-merge-test-gate.js');

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
  const cleanup = () => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ } };
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

test('decideCancelledWait: resume once the server re-triggered the cancelled Land run, else keep waiting', () => {
  // 2026-09-29, run 36629730821: the server had already re-run it (attempt 4, in_progress)
  assert.equal(decideCancelledWait({ status: 'in_progress', attempt: '4', attemptBefore: '3' }), 'resume');
  assert.equal(decideCancelledWait({ status: 'queued', attempt: '1', attemptBefore: '1' }), 'resume');
  // attempt bumped but the API still reports the old completed state
  assert.equal(decideCancelledWait({ status: 'completed', attempt: 2, attemptBefore: 1 }), 'resume');
  // still the cancelled attempt
  assert.equal(decideCancelledWait({ status: 'completed', attempt: '1', attemptBefore: '1' }), 'wait');
  // gh failed: the script's fallback line is "completed 0"
  assert.equal(decideCancelledWait({ status: 'completed', attempt: '0', attemptBefore: '1' }), 'wait');
  assert.equal(decideCancelledWait({}), 'wait');
});

test('decideCancelledLandRetry (BRO-4379): retries only a cancelled Land with green Checks, unchanged tip, budget left', () => {
  const base = { landConclusion: 'cancelled', checksConclusion: 'success', remoteTip: 'a'.repeat(40), tip: 'a'.repeat(40), retriesUsed: 0 };
  assert.deepEqual(decideCancelledLandRetry(base).retry, true);
  assert.deepEqual([0, 1, 2].map(n => decideCancelledLandRetry({ ...base, retriesUsed: n }).backoffSec), [30, 60, 120]);
  // budget matches the server-side re-trigger: the largest attempt budget (a parked job's, BRO-5196) = that many minus 1 re-runs
  assert.equal(MAX_CANCEL_RETRIES, Math.max(require('./land-retry-on-cancel.js').MAX_ATTEMPTS, require('./land-mutex.js').PARKED_MAX_ATTEMPTS) - 1);
  assert.equal(decideCancelledLandRetry({ ...base, retriesUsed: MAX_CANCEL_RETRIES - 1 }).retry, true);
  assert.equal(decideCancelledLandRetry({ ...base, retriesUsed: MAX_CANCEL_RETRIES }).retry, false);
  assert.equal(decideCancelledLandRetry({ ...base, retriesUsed: 1, maxRetries: 1 }).retry, false);
  // Land job not cancelled (failure/success/unknown) or Checks not green → no retry
  for (const landConclusion of ['failure', 'success', 'skipped', '', null, undefined]) assert.equal(decideCancelledLandRetry({ ...base, landConclusion }).retry, false);
  for (const checksConclusion of ['failure', 'cancelled', 'skipped', '', null, undefined]) assert.equal(decideCancelledLandRetry({ ...base, checksConclusion }).retry, false);
  // a newer push moved the branch → that push's run owns the landing
  const moved = decideCancelledLandRetry({ ...base, remoteTip: 'b'.repeat(40) });
  assert.equal(moved.retry, false);
  assert.match(moved.reason, /newer push/);
  // unknown tips and bad counters fail closed
  assert.equal(decideCancelledLandRetry({ ...base, remoteTip: '' }).retry, false);
  assert.equal(decideCancelledLandRetry({ ...base, tip: null }).retry, false);
  for (const retriesUsed of [undefined, -1, 1.5, '0', NaN]) assert.equal(decideCancelledLandRetry({ ...base, retriesUsed }).retry, false);
  assert.equal(decideCancelledLandRetry().retry, false);
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
  for (const f of ['data/audit/stage-latency.jsonl', 'data/audit/x.json', 'public/data/shows/a.json', 'memory/foo.md', 'README.md', 'cloud-memory/MEMORY.md', 'public/opening-night-status.json', 'public/images/shows/annie-1977/poster.jpg']) {
    assert.equal(isInertForVerification(f), true, f);
  }
  for (const f of ['scripts/lib/x.js', 'src/app/page.tsx', '.github/workflows/test.yml', 'package.json', 'scripts/x.sh', 'tests/unit/a.test.mjs', 'public/sitemap.xml', 'public/opening-night-status.json.bak', 'public/images/logo.svg', 'public/favicon.ico']) {
    assert.equal(isInertForVerification(f), false, f);
  }
  // BRO-5732: byte-capped docs are never inert; nested CLAUDE.md files (not capped) stay inert.
  for (const f of ['.claude/CLOUD.md', 'CLAUDE.md', 'AGENTS.md']) assert.equal(isInertForVerification(f), false, f);
  assert.equal(isInertForVerification('.github/workflows/CLAUDE.md'), true);
  assert.equal(classifyIntervening(['data/audit/a.json', '.claude/CLOUD.md']), 'substantive');
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

test('BRO-3945: push rejected because main moved across INERT paths during the push → re-rebased and re-pushed in the same attempt, no re-check', () => {
  const w = makeWorld();
  try {
    w.makeBranch('feat-push-churn');
    let checkRuns = 0; let pushes = 0; const logs = [];
    const r = landBranch({
      branch: 'feat-push-churn', repoDir: w.repoDir, log: (m) => logs.push(m),
      checks: () => { checkRuns++; return greenChecks(); },
      // Bot data commits land while each of the first two pushes is in flight
      // (land.yml run 38270219301 lost three attempts this way on 2026-10-12).
      pushMain: (o) => { pushes++; if (pushes <= 2) w.moveOrigin(`data/audit/churn-${pushes}.json`); plainPush(o); },
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.attempts, 1, 'inert churn during the push does not consume an attempt');
    assert.equal(checkRuns, 1, 'and never re-runs the checks');
    assert.equal(pushes, 3);
    assert.equal(r.churnSkips, 2);
    assert.equal(w.originMain(), r.sha);
    assert.ok(logs.some((l) => /inert churn only, re-rebasing without re-checking/.test(l)), logs.join('\n'));
  } finally { w.cleanup(); }
});

test('BRO-3945: a SUBSTANTIVE move during the push still forces a full re-check', () => {
  const w = makeWorld();
  try {
    w.makeBranch('feat-push-code');
    let checkRuns = 0; let pushes = 0;
    const r = landBranch({
      branch: 'feat-push-code', repoDir: w.repoDir,
      checks: () => { checkRuns++; return greenChecks(); },
      pushMain: (o) => { pushes++; if (pushes === 1) w.moveOrigin('scripts/lib/x.js'); plainPush(o); },
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.attempts, 2);
    assert.equal(checkRuns, 2);
  } finally { w.cleanup(); }
});

test('BRO-3945: a push the server accepted but the client saw fail → landed without pushing again or amending main', () => {
  const w = makeWorld();
  try {
    w.makeBranch('feat-ghost-push');
    let pushes = 0; let amends = 0;
    const r = landBranch({
      branch: 'feat-ghost-push', repoDir: w.repoDir,
      checks: () => greenChecks(),
      beforePush: ({ git: g }) => { amends++; g(['commit', '--amend', '-m', `feat: ghost\n\nTrailer: ${amends}`]); },
      pushMain: (o) => { pushes++; plainPush(o); if (pushes === 1) throw new Error('fatal: the remote end hung up unexpectedly'); },
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.pushed, false, 'nothing left to push: the first push already landed');
    assert.equal(pushes, 1);
    assert.equal(amends, 1, "main's own commit is never amended");
    assert.equal(r.sha, w.originMain());
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

test('BRO-6035: isGeneratedDocConflict is true only when DEPENDENCIES.md is the sole conflicted path', () => {
  assert.equal(isGeneratedDocConflict(['.github/workflows/DEPENDENCIES.md']), true);
  assert.equal(isGeneratedDocConflict(['.github/workflows/DEPENDENCIES.md', 'a.txt']), false);
  assert.equal(isGeneratedDocConflict(['a.txt']), false);
  assert.equal(isGeneratedDocConflict([]), false);
});

function seedGenerator(w) {
  // A stand-in generator: the real one rebuilds the doc from the workflow files.
  w.commitOn(w.other, 'scripts/generate-workflow-dependencies.js',
    "require('fs').mkdirSync('.github/workflows',{recursive:true});require('fs').writeFileSync('.github/workflows/DEPENDENCIES.md','regenerated\\n');\n", 'generator');
  w.commitOn(w.other, '.github/workflows/DEPENDENCIES.md', 'base doc\n', 'doc');
  sh(w.other, ['push', '-q', 'origin', 'HEAD:main']);
  sh(w.repoDir, ['fetch', '-q', 'origin', 'main']);
}

test('BRO-6035: rebase conflict in only DEPENDENCIES.md is regenerated and the landing continues', () => {
  const w = makeWorld();
  try {
    seedGenerator(w);
    sh(w.repoDir, ['checkout', '-q', '-b', 'feat-doc', 'origin/main']);
    w.commitOn(w.repoDir, '.github/workflows/DEPENDENCIES.md', 'branch doc\n', 'branch edits doc');
    w.commitOn(w.repoDir, 'feature.txt', 'f\n', 'feature');
    sh(w.repoDir, ['checkout', '-q', 'main']);
    w.commitOn(w.other, '.github/workflows/DEPENDENCIES.md', 'main doc\n', 'main edits doc');
    sh(w.other, ['push', '-q', 'origin', 'HEAD:main']);
    let pushes = 0;
    const r = landBranch({ branch: 'feat-doc', repoDir: w.repoDir, checks: greenChecks, pushMain: (o) => { pushes++; plainPush(o); } });
    assert.equal(r.failedCheck, null, r.reason);
    assert.equal(r.landed, true);
    assert.equal(pushes, 1);
    assert.equal(w.isAncestorOfOrigin(r.sha), true);
    assert.equal(sh(w.repoDir, ['show', `${r.sha}:.github/workflows/DEPENDENCIES.md`]), 'regenerated');
  } finally { w.cleanup(); }
});

test('BRO-6035: a conflict in DEPENDENCIES.md AND another file still refuses as "rebase"', () => {
  const w = makeWorld();
  try {
    seedGenerator(w);
    sh(w.repoDir, ['checkout', '-q', '-b', 'feat-mixed', 'origin/main']);
    w.commitOn(w.repoDir, '.github/workflows/DEPENDENCIES.md', 'branch doc\n', 'doc');
    w.commitOn(w.repoDir, 'a.txt', 'branch\n', 'a');
    sh(w.repoDir, ['checkout', '-q', 'main']);
    sh(w.other, ['fetch', '-q', 'origin', 'main']); sh(w.other, ['reset', '-q', '--hard', 'origin/main']);
    w.commitOn(w.other, '.github/workflows/DEPENDENCIES.md', 'main doc\n', 'doc');
    w.commitOn(w.other, 'a.txt', 'main\n', 'a');
    sh(w.other, ['push', '-q', 'origin', 'HEAD:main']);
    const r = landBranch({ branch: 'feat-mixed', repoDir: w.repoDir, checks: greenChecks, pushMain: () => {} });
    assert.equal(r.landed, false);
    assert.equal(r.failedCheck, 'rebase');
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
  const inner = (o) => [{ name: 'inner-ran', pass: true, detail: o.baseSha, interveningTests: o.interveningTests }];

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
  assert.deepEqual(out, [{ name: 'inner-ran', pass: true, detail: b, interveningTests: [] }]);

  // Not an ancestor (force-moved main, wrong sha) → real checks, never a skip.
  checks = makeVerifiedBaseChecks({ verifiedBase: v, checks: inner, git: fakeGit('not-ancestor', ['memory/x.md']), prepare: () => [] });
  out = checks({ cwd: '/wt', baseSha: b, repoDir: '/repo' });
  assert.deepEqual(out.map(r => r.name), ['inner-ran']);
});

test('BRO-5732: a capped doc changed on main runs the byte-cap test in the re-check', () => {
  const v = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5732-wt-'));
  try {
    fs.mkdirSync(path.join(wt, 'scripts/tests'), { recursive: true });
    fs.writeFileSync(path.join(wt, CAPPED_DOCS_TEST), '');
    const git = (args) => (args[0] === 'merge-base' ? '' : args[0] === 'diff' ? '.claude/CLOUD.md' : '');
    const seen = [];
    const checks = makeVerifiedBaseChecks({ verifiedBase: v, checks: (o) => { seen.push(o.interveningTests); return []; }, git, prepare: () => [] });
    checks({ cwd: wt, baseSha: b, repoDir: '/repo' });
    assert.deepEqual(seen, [[CAPPED_DOCS_TEST]]);
  } finally { fs.rmSync(wt, { recursive: true, force: true, maxRetries: 3 }); }
});

test('BRO-5180: a substantive move hands the test files main changed since the verified base to the merged-tree floor', () => {
  const v = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  // gone.test.mjs: main deleted it, so it is absent from the rebased tree.
  const intervening = ['tests/unit/sibling-matchers-diacritics.test.mjs', 'src/x.ts', 'tests/unit/old.test.js', 'scripts/lib/foo.test.mjs', 'scripts/lib/foo.js', 'tests/unit/gone.test.mjs'];
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5180-wt-'));
  try {
    for (const f of ['tests/unit/sibling-matchers-diacritics.test.mjs', 'scripts/lib/foo.test.mjs']) {
      fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
      fs.writeFileSync(path.join(wt, f), '');
    }
    const git = (args) => (args[0] === 'merge-base' ? '' : args[0] === 'diff' ? intervening.join('\n') : '');
    let seen = null;
    const checks = makeVerifiedBaseChecks({ verifiedBase: v, checks: (o) => { seen = o; return []; }, git, prepare: () => [] });
    const logs = [];
    checks({ cwd: wt, baseSha: b, repoDir: '/repo', changedFiles: ['scripts/diagnostics/x.js'], log: (l) => logs.push(l) });
    assert.deepEqual(seen.interveningTests, ['tests/unit/sibling-matchers-diacritics.test.mjs', 'scripts/lib/foo.test.mjs']);
    assert.deepEqual(seen.changedFiles, ['scripts/diagnostics/x.js'], 'the branch diff itself is untouched');
    assert.match(logs.join('\n'), /\+2 test file\(s\) changed on main/);
    assert.doesNotMatch(logs.join('\n'), /full gauntlet/, 'the re-check is not the full gauntlet and must not say so');

    // Not an ancestor: the window is unknown, and the log must say so rather than "+0".
    const notAnc = makeVerifiedBaseChecks({ verifiedBase: v, checks: () => [], git: (args) => (args[0] === 'merge-base' ? null : ''), prepare: () => [] });
    const logs2 = [];
    notAnc({ cwd: wt, baseSha: b, repoDir: '/repo', log: (l) => logs2.push(l) });
    assert.match(logs2.join('\n'), /unknown: verified base is not an ancestor/);
  } finally {
    fs.rmSync(wt, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }

  assert.deepEqual(mergedTreeGateInput(['a.js', 't/x.test.mjs'], ['t/x.test.mjs', 't/y.test.mjs']), ['a.js', 't/x.test.mjs', 't/y.test.mjs']);
  assert.deepEqual(mergedTreeGateInput(['a.js'], undefined), ['a.js']);
});

test('BRO-5180: the floor actually selects an intervening guard the branch diff alone would never reach', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5180-'));
  try {
    fs.mkdirSync(path.join(root, 'tests', 'unit'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts', 'diagnostics'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'unit', 'guard.test.mjs'), '');
    fs.writeFileSync(path.join(root, 'scripts', 'diagnostics', 'new.js'), '');
    const branch = ['scripts/diagnostics/new.js'];
    assert.ok(!selectTestFiles(root, branch).includes('tests/unit/guard.test.mjs'), 'precondition: the branch diff alone misses the guard (the incident)');
    assert.ok(selectTestFiles(root, mergedTreeGateInput(branch, ['tests/unit/guard.test.mjs'])).includes('tests/unit/guard.test.mjs'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
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


// ── partial clone (the Land job checks out with filter: blob:none) ──────────

test('isPromisorFetchFailure: the real Land stderr retries, a content conflict never does', () => {
  // Verbatim shape from run 36351955579 (land/our-sinatra, 3-commit branch).
  const real = 'fatal: remote error: upload-pack: not our ref e31a1e453a95c0ffee\nfatal: could not fetch bc4a5adf from promisor remote';
  assert.equal(isPromisorFetchFailure(real), true);
  assert.equal(isPromisorFetchFailure('error: could not fetch 1234 from promisor remote'), true);
  assert.equal(isPromisorFetchFailure('CONFLICT (content): Merge conflict in a.txt\nerror: could not apply 1234... feat'), false);
  assert.equal(isPromisorFetchFailure('CONFLICT (content): x\nfatal: not our ref abc'), false, 'a real conflict is never masked by a retry');
  assert.equal(isPromisorFetchFailure(''), false);
  assert.equal(isPromisorFetchFailure(undefined), false);
});

test('lands a multi-commit branch needing 3-way merges from a blobless clone, with no blobs left missing', () => {
  const w = makeWorld();
  try {
    sh(w.origin, ['config', 'uploadpack.allowFilter', 'true']);
    sh(w.origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    // Shared files both sides edit (different lines), so every pick 3-way merges.
    const lines = (tag) => Array.from({ length: 40 }, (_, i) => `line ${i}${tag && i === 0 ? ` ${tag}` : ''}`).join('\n') + '\n';
    sh(w.other, ['fetch', '-q', 'origin', 'main']); sh(w.other, ['reset', '-q', '--hard', 'origin/main']);
    for (const f of ['m1.txt', 'm2.txt']) w.commitOn(w.other, f, lines(''), `seed ${f}`);
    sh(w.other, ['push', '-q', 'origin', 'HEAD:main']);

    const part = path.join(w.root, 'partial');
    sh(w.root, ['clone', '-q', '--no-local', '--filter=blob:none', `file://${w.origin}`, part]);
    sh(part, ['config', 'user.email', 't@e.st']); sh(part, ['config', 'user.name', 'test']);
    sh(part, ['checkout', '-q', '-b', 'feat-multi', 'origin/main']);
    const lastLine = (tag) => lines('').replace(/line 39\n$/, `line 39 ${tag}\n`);
    w.commitOn(part, 'm1.txt', lastLine('branch-1'), 'feat 1');
    w.commitOn(part, 'm2.txt', lastLine('branch-2'), 'feat 2');
    w.commitOn(part, 'm1.txt', lastLine('branch-3'), 'feat 3');
    sh(part, ['push', '-q', 'origin', 'feat-multi']);
    sh(part, ['checkout', '-q', '--detach', 'origin/main']);

    // main edits the first line of both files, then the partial clone refetches
    // (commits/trees only — the new blobs stay missing until someone reads them).
    sh(w.other, ['fetch', '-q', 'origin', 'main']); sh(w.other, ['reset', '-q', '--hard', 'origin/main']);
    w.commitOn(w.other, 'm1.txt', lines('main'), 'main m1');
    w.commitOn(w.other, 'm2.txt', lines('main'), 'main m2');
    sh(w.other, ['push', '-q', 'origin', 'HEAD:main']);

    const logs = [];
    const r = landBranch({
      branch: 'feat-multi', repoDir: part, source: 'origin',
      checks: () => greenChecks(), pushMain: plainPush, log: (m) => logs.push(m),
    });
    assert.equal(r.landed, true, JSON.stringify(r) + logs.join('\n'));
    assert.equal(r.attempts, 1);
    const landed = sh(w.other, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
    const show = (f) => execFileSync('git', ['--git-dir', w.origin, 'show', `${landed}:${f}`], { encoding: 'utf8' });
    assert.match(show('m1.txt'), /^line 0 main\n[\s\S]*line 39 branch-3\n$/);
    assert.match(show('m2.txt'), /^line 0 main\n[\s\S]*line 39 branch-2\n$/);
  } finally { w.cleanup(); }
});

test('BRO-4379 wiring: the session landing script consults decideCancelledLandRetry, then WAITS for the server-side re-trigger instead of re-running itself', () => {
  const sh = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', ['merge', 'worktree-to', 'main.sh'].join('-')), 'utf8');
  assert.match(sh, /decideCancelledLandRetry/);
  assert.match(sh, /decideCancelledWait/);
  assert.match(sh, /cancel_retries/);
  // A local rerun races land-retry-cancelled.yml: once the server has re-run
  // the job, `gh run rerun` fails "already running" and the script used to
  // print a false REFUSED (run 36629730821, 2026-09-29).
  assert.doesNotMatch(sh, /gh run rerun/, 'the landing script must not re-run land.yml itself');
  // the grace wait stays inside the shared budget and ends in a resumable TIMEOUT
  assert.match(sh, /grace_end=\$budget_deadline/);
  assert.match(sh, /TIMEOUT: \$BRANCH — land run cancelled/);
  // no re-trigger seen within the grace window is not proof of refusal (Codex review)
  assert.match(sh, /TIMEOUT: \$BRANCH — land run cancelled while pending and no server re-trigger seen/);
  // a run that went live again between the waiter's verdict and the re-read keeps waiting
  assert.match(sh, /run_status" != "completed"/);
});

// ── BRO-5700: the smaller in-mutex re-check ────────────────────────────────

test('selectRecheckScope: small only when main\'s files are known and share none with the branch; fails closed', () => {
  const branch = ['scripts/lib/foo.js', 'scripts/lib/foo.test.mjs'];
  let r = selectRecheckScope({ ancestor: true, intervening: ['scripts/lib/bar.js', 'tests/unit/guard.test.mjs'], changedFiles: branch });
  assert.equal(r.mode, 'small');
  assert.equal(r.build, false, 'no src/ change on the branch');
  // A file changed on both sides → the full re-check.
  r = selectRecheckScope({ ancestor: true, intervening: ['scripts/lib/foo.js'], changedFiles: branch });
  assert.equal(r.mode, 'full');
  assert.match(r.reason, /both changed 1 file/);
  // Unknown window: not an ancestor, or the diff failed (null) → full, never small.
  assert.equal(selectRecheckScope({ ancestor: false, intervening: [], changedFiles: branch }).mode, 'full');
  assert.equal(selectRecheckScope({ ancestor: true, intervening: null, changedFiles: branch }).mode, 'full');
  assert.equal(selectRecheckScope({ ancestor: undefined, intervening: [], changedFiles: branch }).mode, 'full');
  // The switch restores today's re-check.
  assert.equal(selectRecheckScope({ ancestor: true, intervening: ['x.md'], changedFiles: branch, disabled: true }).mode, 'full');
});

test('selectRecheckScope: the build runs only when the branch changed src/ and main changed build code (bot data churn does not count)', () => {
  const src = ['src/components/X.tsx'];
  assert.equal(selectRecheckScope({ ancestor: true, intervening: ['scripts/lib/review-list-key.js'], changedFiles: src }).build, true, 'src/ imports scripts/lib');
  assert.equal(selectRecheckScope({ ancestor: true, intervening: ['next.config.js'], changedFiles: src }).build, true);
  assert.equal(selectRecheckScope({ ancestor: true, intervening: ['public/data/shows/x.json', 'data/audit/ledger.jsonl', 'memory/a.md'], changedFiles: src }).build, false);
  assert.equal(selectRecheckScope({ ancestor: true, intervening: ['src/app/page.tsx'], changedFiles: ['scripts/lib/a.test.mjs'] }).build, false, 'runSafeChecks builds only for a src/ change on the branch');
  assert.equal(isBuildCodePath('scripts/prebuild.sh'), true, 'scripts/ is build code on main\'s side (prebuild, src/ imports scripts/lib)');
  assert.equal(isBuildCodePath('public/data/mobile-shows.json'), false);
  assert.equal(isBuildCodePath('public/images/x.webp'), true);
  assert.equal(isBuildCodePath('package-lock.json'), true);
  assert.equal(isBuildCodePath('.github/workflows/land.yml'), false);
});

test('makeVerifiedBaseChecks hands the scope to the checks seam; a failed diff makes it full', () => {
  const v = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  let seen = null;
  const run = (git) => {
    const checks = makeVerifiedBaseChecks({ verifiedBase: v, checks: (o) => { seen = o; return []; }, git, prepare: () => [] });
    checks({ cwd: '/wt', baseSha: b, repoDir: '/repo', changedFiles: ['scripts/lib/foo.js'] });
    return seen.recheckScope;
  };
  // main's window is `verified..base`; the branch's own files are `base...HEAD`.
  const fake = (mainFiles, branchFiles) => (args) => {
    if (args[0] === 'merge-base') return '';
    if (args[0] !== 'diff') return '';
    return String(args[args.length - 1]).endsWith('...HEAD') ? branchFiles : mainFiles;
  };
  assert.equal(run(fake('scripts/lib/bar.js', 'scripts/lib/foo.js')).mode, 'small');
  assert.equal(run(fake('scripts/lib/foo.js', 'scripts/lib/foo.js')).mode, 'full');
  assert.equal(run((args) => (args[0] === 'merge-base' ? '' : null)).mode, 'full', 'git diff failed → unknown → full');
  // Branch-side rename: `git mv scripts/lib/foo.js scripts/lib/foo2.js` while main edits foo.js.
  const renamed = (args) => {
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'diff' && String(args[args.length - 1]).endsWith('...HEAD')) return 'scripts/lib/foo.js\nscripts/lib/foo2.js';
    return args[0] === 'diff' ? 'scripts/lib/foo.js' : '';
  };
  assert.equal(run(renamed).mode, 'full', 'a branch rename of a file main edited is an overlap');
  // Branch-side diff failed → unknown → full.
  assert.equal(run((args) => (args[0] === 'merge-base' ? '' : String(args[args.length - 1]).endsWith('...HEAD') ? null : 'x.md')).mode, 'full');
  // The holder alone after a red train always re-checks in full.
  const checks = makeVerifiedBaseChecks({ verifiedBase: v, checks: (o) => { seen = o; return []; }, git: (args) => (args[0] === 'merge-base' ? '' : 'x.md'), prepare: () => [] });
  checks({ cwd: '/wt', baseSha: b, repoDir: '/repo', changedFiles: ['scripts/lib/foo.js'], forceFullRecheck: true });
  assert.equal(seen.recheckScope.mode, 'full');
  const diffArgs = [];
  run((args) => { if (args[0] === 'diff') diffArgs.push(...args); return args[0] === 'merge-base' ? '' : 'x.md'; });
  assert.ok(diffArgs.includes('--no-renames'), 'a rename on main shows both names to the overlap test');
});

test('BRO-6276 deadline: a lost race past the deadline stops before attempt 2 and hands back a clean refusal', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-deadline');
    let clock = 0;
    let pushCalls = 0;
    const r = landBranch({
      branch: 'feat-deadline', repoDir: w.repoDir,
      checks: (...a) => { clock += 60 * 60 * 1000; return greenChecks(...a); },
      pushMain: (o) => { pushCalls++; w.moveOrigin(); plainPush(o); },
      now: () => clock, deadlineMs: 55 * 60 * 1000,
    });
    assert.equal(r.landed, false);
    assert.equal(r.failedCheck, 'deadline');
    assert.equal(r.attempts, 1);
    assert.equal(pushCalls, 1, 'no second attempt once past the deadline');
    assert.match(r.reason, /not starting attempt 2/);
    assert.equal(w.isAncestorOfOrigin(tip), false);
    assert.equal(w.worktreeCount(), 1, 'worktree cleaned up');
  } finally { w.cleanup(); }
});

test('BRO-6276 deadline: under the deadline the retry still runs and lands', () => {
  const w = makeWorld();
  try {
    const tip = w.makeBranch('feat-deadline-ok');
    let pushCalls = 0;
    const r = landBranch({
      branch: 'feat-deadline-ok', repoDir: w.repoDir, checks: greenChecks,
      pushMain: (o) => { pushCalls++; if (pushCalls === 1) w.moveOrigin(); plainPush(o); },
      now: () => 0, deadlineMs: 55 * 60 * 1000,
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.equal(r.attempts, 2);
    assert.notEqual(r.sha, tip);
    assert.equal(w.isAncestorOfOrigin(r.sha), true);
  } finally { w.cleanup(); }
});

test('BRO-6276 deadlineRefusal / landDeadlineMs: attempt 1 always runs; bad env values keep the default', () => {
  assert.equal(deadlineRefusal({ attempt: 1, elapsedMs: 1e9, deadlineMs: 1 }), null);
  assert.equal(deadlineRefusal({ attempt: 2, elapsedMs: 10, deadlineMs: 100 }), null);
  assert.match(deadlineRefusal({ attempt: 3, elapsedMs: 100, deadlineMs: 100 }), /attempt 3/);
  assert.equal(landDeadlineMs({}), DEFAULT_LAND_DEADLINE_MS);
  assert.equal(landDeadlineMs({ LAND_DEADLINE_MIN: '40' }), 40 * 60 * 1000);
  assert.equal(landDeadlineMs({ LAND_DEADLINE_MIN: '0' }), 0, '0 = no retries');
  assert.equal(landDeadlineMs({ LAND_DEADLINE_MIN: '4' }), 4 * 60 * 1000);
  for (const bad of ['121', 'abc', '30.5', '-10', '']) assert.equal(landDeadlineMs({ LAND_DEADLINE_MIN: bad }), DEFAULT_LAND_DEADLINE_MS, bad);
  assert.match(deadlineRefusal({ attempt: 2, elapsedMs: 0, deadlineMs: 0 }), /not starting attempt 2/);
});

test('BRO-6276 push marker: the sha about to be pushed is written before each push', () => {
  const w = makeWorld();
  const marker = path.join(w.repoDir, '..', `marker-${process.pid}`);
  try {
    w.makeBranch('feat-marker');
    const seen = [];
    const r = landBranch({
      branch: 'feat-marker', repoDir: w.repoDir, checks: greenChecks, pushMarkerFile: marker,
      pushMain: (o) => { seen.push([o.sha, fs.readFileSync(marker, 'utf8').trim()]); plainPush(o); },
    });
    assert.equal(r.landed, true, JSON.stringify(r));
    assert.deepEqual(seen, [[r.sha, r.sha]]);
  } finally { fs.rmSync(marker, { force: true }); w.cleanup(); }
});

test('BRO-6276 selectTrainRecheckScope: small only when no two members (or main) share a file and every base is verified', () => {
  const A40 = 'a'.repeat(40);
  const B40 = 'b'.repeat(40);
  const mem = (name, files, o = {}) => ({ name, base: A40, verified: true, ancestor: true, mainChanged: [], files, ...o });
  const s = (members, extra = {}) => selectTrainRecheckScope({ members, ...extra });
  assert.equal(s([mem('h', ['scripts/lib/a.js']), mem('r', ['scripts/lib/b.js'])]).mode, 'small', 'disjoint members');
  assert.equal(s([mem('h', ['scripts/lib/a.js']), mem('r', ['scripts/lib/a.js'])]).mode, 'full', 'rider and holder share a file');
  assert.equal(s([mem('h', ['x.js']), mem('r1', ['y.js']), mem('r2', ['y.js'])]).mode, 'full', 'two riders share a file');
  assert.equal(s([mem('h', ['x.js']), mem('r', ['y.js'], { mainChanged: ['y.js'] })]).mode, 'full', 'main changed a rider file since its base');
  assert.match(s([mem('h', ['x.js']), mem('r', ['y.js'], { verified: false })]).reason, /r has no verified base/, 'merge-base fallback is not a verified base');
  assert.equal(s([mem('h', ['x.js'], { base: null, verified: false }), mem('r', ['y.js'])]).mode, 'full', 'holder without --verified-base');
  assert.equal(s([mem('h', ['x.js']), mem('r', ['y.js'], { ancestor: false, mainChanged: null })]).mode, 'full', 'base not an ancestor of main');
  assert.equal(s([mem('h', ['x.js']), mem('r', null)]).mode, 'full', 'unknown rider files');
  assert.equal(s([mem('h', ['x.js']), mem('r', ['y.js'], { mainChanged: null })]).mode, 'full', 'main diff failed');
  assert.equal(s([mem('h', ['x.js']), mem('r', ['y.js'])], { disabled: true }).mode, 'full', 'kill switch');
  assert.equal(s([mem('h', ['x.js'])]).mode, 'full', 'one member is not a train');
  // Build: src/ in one member and build code in another member (or main) → build runs.
  const b1 = s([mem('h', ['src/app/page.tsx']), mem('r', ['next.config.js'], { base: B40 })]);
  assert.deepEqual([b1.mode, b1.build], ['small', true]);
  const b2 = s([mem('h', ['src/app/page.tsx']), mem('r', ['memory/notes.md'])]);
  assert.deepEqual([b2.mode, b2.build], ['small', false]);
  const b3 = s([mem('h', ['src/app/page.tsx'], { mainChanged: ['package-lock.json'] }), mem('r', ['docs.md'])]);
  assert.equal(b3.build, true, 'main changed build code since the src/ member was verified');
});

test('BRO-6276 checkTimings: names where the in-lock re-check spent its time', () => {
  assert.equal(
    checkTimings({ safeMs: 252_400, extra: [{ name: 'merged-tree-tests', pass: true, ms: 543_000 }, { name: 'bash-syntax', pass: false, ms: 900 }, { name: 'no-ms', pass: true }] }),
    'safe-checks 4m12s, merged-tree-tests 9m3s, bash-syntax 1s',
  );
  assert.equal(checkTimings({ safeMs: 0 }), 'safe-checks 0s');
});

test('BRO-6519: a bot ledger BOTH sides changed is not an overlap (small re-check); anything else shared stays full', () => {
  const AL = 'data/audit/alert-ledger.json';
  const SP = 'data/audit/scraper-spend-ledger.jsonl';
  const branch = ['scripts/lib/foo.js', AL, SP];
  const yes = () => true;
  const r = selectRecheckScope({ ancestor: true, intervening: [AL, SP], changedFiles: branch, ledgerOk: yes });
  assert.equal(r.mode, 'small', r.reason);
  // the union-merged .jsonl needs no parse check; the keyed .json does
  assert.equal(selectRecheckScope({ ancestor: true, intervening: [SP], changedFiles: branch }).mode, 'small');
  assert.equal(selectRecheckScope({ ancestor: true, intervening: [AL], changedFiles: branch }).mode, 'full', 'no ledgerOk -> unknown -> full');
  assert.equal(selectRecheckScope({ ancestor: true, intervening: [AL], changedFiles: branch, ledgerOk: () => false }).mode, 'full', 'merged .json does not parse -> full');
  // a real shared file next to a ledger still forces full
  assert.equal(selectRecheckScope({ ancestor: true, intervening: [AL, 'scripts/lib/foo.js'], changedFiles: branch, ledgerOk: yes }).mode, 'full');
  // other shared inert data keeps the conservative full re-check
  assert.equal(selectRecheckScope({ ancestor: true, intervening: ['data/audit/other.json'], changedFiles: ['data/audit/other.json'], ledgerOk: yes }).mode, 'full');
  assert.equal(selectRecheckScope({ ancestor: true, intervening: ['data/audit/landings.jsonl'], changedFiles: ['data/audit/landings.jsonl'] }).mode, 'full');
  assert.equal(isMergeableBothSidesLedger('scripts/alert-ledger.json', yes), false);
  assert.equal(isMergeableBothSidesLedger('data/audit/alert-ledger.json.bak', yes), false);
  // the switch still wins
  assert.equal(selectRecheckScope({ ancestor: true, intervening: [SP], changedFiles: branch, disabled: true }).mode, 'full');
  // trains: two members appending the union-merged ledger stay small
  const t = selectTrainRecheckScope({ members: ['a', 'b'].map((n) => ({ name: n, base: 'a'.repeat(40), verified: true, ancestor: true, mainChanged: [SP], files: [SP, `scripts/lib/${n}.js`] })) });
  assert.equal(t.mode, 'small', t.reason);
});

test('BRO-6519: jsonFileParses reads the merged ledger from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-parse-'));
  const good = path.join(dir, 'good.json');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(good, '{"a":{"notifyCount":1}}\n');
  fs.writeFileSync(bad, '{"a":1,\n<<<<<<< HEAD\n');
  assert.equal(jsonFileParses(good), true);
  assert.equal(jsonFileParses(bad), false);
  assert.equal(jsonFileParses(path.join(dir, 'missing.json')), false);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('BRO-6519: makeVerifiedBaseChecks checks the MERGED alert ledger in cwd before calling a both-sides edit small', () => {
  const v = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const AL = 'data/audit/alert-ledger.json';
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-wt-'));
  fs.mkdirSync(path.join(wt, 'data', 'audit'), { recursive: true });
  const ledger = path.join(wt, 'data', 'audit', 'alert-ledger.json');
  let seen = null;
  const git = (args) => {
    if (args[0] === 'merge-base') return '';
    if (args[0] !== 'diff') return '';
    return String(args[args.length - 1]).endsWith('...HEAD') ? `scripts/lib/foo.js\n${AL}` : `scripts/lib/bar.js\n${AL}`; // substantive move: re-check
  };
  const scope = () => {
    makeVerifiedBaseChecks({ verifiedBase: v, checks: (o) => { seen = o; return []; }, git, prepare: () => [] })({ cwd: wt, baseSha: b, repoDir: '/repo', changedFiles: ['scripts/lib/foo.js', AL] });
    return seen.recheckScope;
  };
  try {
    fs.writeFileSync(ledger, '{"cond":{"notifyCount":2}}\n');
    assert.equal(scope().mode, 'small', 'clean merged ledger -> small');
    fs.writeFileSync(ledger, '{"cond":{"notifyCount":2},}\n');
    assert.equal(scope().mode, 'full', 'merged ledger no longer parses -> full');
  } finally {
    fs.rmSync(wt, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
