// tests/unit/review-gate.test.mjs — push-boundary review gate (Notion 39c637c5).
//
// The gate must be prose-independent: it fires on the push, not on what the
// session said. Acceptance (from the card): a >30-line scripts/ diff with no
// review verdict is BLOCKED; the same push after /ship-check records a pass
// verdict is allowed. Tests run against scratch git repos in a tmpdir — no
// project data needed (no-data CI batch).

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GATE_LINE_BUDGET,
  DRIFT_BUDGET_LINES,
  SECOND_OPINION_MAX_LINES,
  gatedDiffStats,
  gatedDiffPatchText,
  computeDiffHash,
  queryPushAllowed,
  queryCiRedClaimConflict,
  recordVerdict,
  resolveBase,
} from '../../scripts/lib/review-gate.mjs';
import { appendClaim } from '../../scripts/lib/ci-red-claims.js';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

// Scratch repo with an initial commit on main and a simulated origin/main.
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'review-gate-test-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'data'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'base.js'), 'console.log(1);\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  // Freeze this commit as origin/main so later commits diff against it.
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
}

function commitLines(repo, relPath, nLines, msg = 'change') {
  const dir = join(repo, relPath.split('/').slice(0, -1).join('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(repo, relPath),
    Array.from({ length: nLines }, (_, i) => `console.log(${i}); // ${msg}`).join('\n') + '\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
}

test('under-budget diff is not gated', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitLines(repo, 'scripts/small.js', GATE_LINE_BUDGET - 5, 'small');
  const r = queryPushAllowed({ repoRoot: repo });
  assert.equal(r.allowed, true);
  assert.equal(r.gated, false);
});

test('ACCEPTANCE: >30-line scripts/ diff with no verdict is BLOCKED', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitLines(repo, 'scripts/monitor.js', 60, 'gate-ab monitor');
  const r = queryPushAllowed({ repoRoot: repo });
  assert.equal(r.gated, true);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /no review verdict/);
  assert.ok(r.gatedLines > GATE_LINE_BUDGET);
});

test('ACCEPTANCE: same push after ship-check verdict is allowed (exact hash)', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitLines(repo, 'scripts/monitor.js', 60, 'gate-ab monitor');
  const rec = recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'pass' });
  assert.equal(rec.recorded, true);
  const r = queryPushAllowed({ repoRoot: repo });
  assert.equal(r.allowed, true);
  assert.equal(r.via, 'exact-hash');
});

test('fail verdict does not unlock the push', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitLines(repo, 'scripts/monitor.js', 60, 'monitor');
  recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'fail' });
  const r = queryPushAllowed({ repoRoot: repo });
  assert.equal(r.allowed, false);
});

test('post-review fixups within drift budget still pass', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitLines(repo, 'scripts/monitor.js', 60, 'monitor');
  recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'pass' });
  commitLines(repo, 'scripts/monitor.js', 70, 'fixup after review'); // rewrites file: 60 del + 70 add = 130 ≤ 150
  const r = queryPushAllowed({ repoRoot: repo });
  assert.equal(r.allowed, true, JSON.stringify(r));
  assert.equal(r.via, 'fixup-drift');
  assert.ok(r.driftLines <= DRIFT_BUDGET_LINES);
});

test('drift beyond budget re-blocks (fixups themselves need review)', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitLines(repo, 'scripts/monitor.js', 60, 'monitor');
  recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'pass' });
  commitLines(repo, 'scripts/other.js', DRIFT_BUDGET_LINES + 50, 'big new work');
  const r = queryPushAllowed({ repoRoot: repo });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /stale verdict/);
});

test('second-opinion verdict only counts for small diffs', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitLines(repo, 'scripts/big.js', SECOND_OPINION_MAX_LINES + 50, 'big');
  recordVerdict({ repoRoot: repo, reviewer: 'second-opinion', result: 'pass' });
  const big = queryPushAllowed({ repoRoot: repo });
  assert.equal(big.allowed, false, 'light review must not rubber-stamp a big diff');

  const repo2 = makeRepo();
  t.after(() => rmSync(repo2, { recursive: true, force: true }));
  commitLines(repo2, 'scripts/mid.js', 50, 'mid');
  recordVerdict({ repoRoot: repo2, reviewer: 'second-opinion', result: 'pass' });
  const mid = queryPushAllowed({ repoRoot: repo2 });
  assert.equal(mid.allowed, true);
});

test('non-code paths (data/, docs) never gate', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitLines(repo, 'data/scratch-fixture.json', 500, 'data churn');
  writeFileSync(join(repo, 'README.md'), 'x\n'.repeat(200));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'docs');
  const r = queryPushAllowed({ repoRoot: repo });
  assert.equal(r.allowed, true);
  assert.equal(r.gated, false);
});

test('src/ TypeScript and workflow yml are gated paths; css is not', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitLines(repo, 'src/lib/engine.ts', 40, 'logic');
  commitLines(repo, '.github/workflows/deploy.yml', 40, 'wf');
  writeFileSync(join(repo, 'src', 'styles.css'), 'a{}\n'.repeat(100));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'css');
  const base = resolveBase(repo);
  const stats = gatedDiffStats(repo, base, 'HEAD');
  const paths = stats.files.map(f => f.path).sort();
  assert.deepEqual(paths, ['.github/workflows/deploy.yml', 'src/lib/engine.ts']);
  assert.equal(stats.totalLines, 80);
});

test('diffHash is content-addressed: merge commit with identical diff keeps the verdict', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'checkout', '-q', '-b', 'feature');
  commitLines(repo, 'scripts/feature.js', 60, 'feature work');
  const rec = recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'pass' });
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
  const base = resolveBase(repo);
  assert.equal(computeDiffHash(repo, base, 'HEAD'), rec.entry.diffHash);
  const r = queryPushAllowed({ repoRoot: repo });
  assert.equal(r.allowed, true);
  assert.equal(r.via, 'exact-hash');
});

test('renamed gated file still counts toward the budget', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitLines(repo, 'scripts/old-name.js', 60, 'v1');
  git(repo, 'mv', 'scripts/old-name.js', 'scripts/new-name.js');
  git(repo, 'commit', '-q', '-m', 'rename');
  const base = resolveBase(repo);
  const stats = gatedDiffStats(repo, base, 'HEAD');
  assert.ok(stats.files.some(f => f.path === 'scripts/new-name.js'), JSON.stringify(stats.files));
});

test('no-base scratch clone fails open (never wedges)', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'review-gate-nobase-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'trunk'); // no main, no origin/main
  git(repo, 'config', 'user.email', 't@e.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'x.txt'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const r = queryPushAllowed({ repoRoot: repo });
  assert.equal(r.allowed, true);
});

// ── CI-red claim conflict (task #584 — closes the #542 wiring gap) ─────────
// The claim ledger + predicate already shipped (scripts/lib/ci-red-claims.js,
// scripts/lib/duplicate-dispatch-guard.js); this wires them into the actual
// push-boundary hook. Independent of queryPushAllowed above — its own
// function, own tests — so it can't regress the existing gate's coverage.

function tmpClaimsPath() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-red-claims-gate-test-'));
  return join(dir, 'ci-red-claims.jsonl');
}

test('gatedDiffPatchText: contains gated-file content, excludes non-gated paths', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitLines(repo, 'scripts/monitor.js', 5, 'shouldShowSentiment fix');
  writeFileSync(join(repo, 'data', 'scratch.json'), '{"shouldShowSentiment": true}\n'.repeat(5));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'data churn');
  const base = resolveBase(repo);
  const patch = gatedDiffPatchText(repo, base, 'HEAD');
  assert.match(patch, /shouldShowSentiment fix/);
  assert.doesNotMatch(patch, /"shouldShowSentiment": true/);
});

test('queryCiRedClaimConflict: no claims file — not blocked (fail open)', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitLines(repo, 'scripts/fix.js', 3, 'shouldShowSentiment fix');
  const r = queryCiRedClaimConflict({ repoRoot: repo, claimsPath: '/nonexistent/ci-red-claims.jsonl' });
  assert.equal(r.blocked, false);
});

test('queryCiRedClaimConflict: diff matches another in_progress claim — blocked', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const claimsPath = tmpClaimsPath();
  appendClaim({ taskId: '563', symbol: 'shouldShowSentiment' }, claimsPath);
  commitLines(repo, 'scripts/fix.js', 3, 'shouldShowSentiment ReferenceError fix');
  const r = queryCiRedClaimConflict({ repoRoot: repo, claimsPath });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /#563/);
});

test('queryCiRedClaimConflict: own claim excluded via ownTaskId — not blocked', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const claimsPath = tmpClaimsPath();
  appendClaim({ taskId: '584', symbol: 'shouldShowSentiment' }, claimsPath);
  commitLines(repo, 'scripts/fix.js', 3, 'shouldShowSentiment ReferenceError fix');
  const r = queryCiRedClaimConflict({ repoRoot: repo, claimsPath, ownTaskId: '584' });
  assert.equal(r.blocked, false);
});

test('queryCiRedClaimConflict: diff does not reference the claimed symbol — not blocked', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const claimsPath = tmpClaimsPath();
  appendClaim({ taskId: '563', symbol: 'shouldShowSentiment' }, claimsPath);
  commitLines(repo, 'scripts/unrelated.js', 5, 'unrelated typo fix');
  const r = queryCiRedClaimConflict({ repoRoot: repo, claimsPath });
  assert.equal(r.blocked, false);
});

test('queryCiRedClaimConflict: expired claim (past TTL) does not block', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const claimsPath = tmpClaimsPath();
  appendClaim({ taskId: '563', symbol: 'shouldShowSentiment' }, claimsPath);
  commitLines(repo, 'scripts/fix.js', 3, 'shouldShowSentiment ReferenceError fix');
  const farFuture = Date.now() + 3 * 60 * 60 * 1000; // beyond CLAIM_TTL_MS (2h)
  const r = queryCiRedClaimConflict({ repoRoot: repo, claimsPath, now: farFuture });
  assert.equal(r.blocked, false);
});

test('queryCiRedClaimConflict: matches on runId too', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const claimsPath = tmpClaimsPath();
  appendClaim({ taskId: '9', runId: '30120249897' }, claimsPath);
  commitLines(repo, 'scripts/fix.js', 3, 'fix flake in CI run 30120249897');
  const r = queryCiRedClaimConflict({ repoRoot: repo, claimsPath });
  assert.equal(r.blocked, true);
});

// Adversarial review (task #584): `symbol || runId` previously meant a claim
// with BOTH set only ever searched the symbol — a diff naming just the runId
// silently passed through. Both fields must be checked independently.
test('queryCiRedClaimConflict: claim has both symbol+runId, diff matches only runId — still blocked', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const claimsPath = tmpClaimsPath();
  appendClaim({ taskId: '9', symbol: 'shouldShowSentiment', runId: '30120249897' }, claimsPath);
  commitLines(repo, 'scripts/fix.js', 3, 'fix flake in CI run 30120249897');
  const r = queryCiRedClaimConflict({ repoRoot: repo, claimsPath });
  assert.equal(r.blocked, true, JSON.stringify(r));
});

// Adversarial review (task #584): a short generic claimed symbol would match
// almost any diff via plain substring search — a minimum length floor keeps
// the heuristic from firing on unrelated pushes.
test('queryCiRedClaimConflict: short generic symbol below MIN_NEEDLE_LEN does not block', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const claimsPath = tmpClaimsPath();
  appendClaim({ taskId: '9', symbol: 'run' }, claimsPath);
  commitLines(repo, 'scripts/unrelated.js', 5, 'totally unrelated change to run the pipeline');
  const r = queryCiRedClaimConflict({ repoRoot: repo, claimsPath });
  assert.equal(r.blocked, false);
});
