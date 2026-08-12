// tests/unit/review-gate-merge.test.mjs — the MERGE-boundary review gate
// (task #1304, owner-approved 2026-08-12).
//
// The push gate (tests/unit/review-gate.test.mjs) proves unreviewed code can't
// be PUSHED. That is one step too late: ~20 parallel sessions share the one
// local main checkout, so an unreviewed MERGE is already on shared main by the
// time the push gate fires, and any other session's push carries it to origin.
// These tests cover the merge side.
//
// Two properties matter more than "does it block", and are tested hardest:
//   1. FAIL OPEN on every infrastructure error. A wedged merge blocks every
//      session's only integration path — strictly worse than a missed block.
//   2. The gate must not fire on merges it has no business gating:
//      `git merge --abort`, `git pull`, merges into a non-main branch, or a
//      command that also pushes (which pre-push-review-gate.sh:187-211 already
//      owns — double-firing starves the shared one-shot override marker and
//      turns an explicit user override into a FALSE BLOCK).
//
// Per CLAUDE.md rule 15 this imports the REAL functions — it does not restate
// their logic. Scratch git repos in a tmpdir, no project data (no-data CI batch).

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GATE_LINE_BUDGET,
  LEDGER_REL_PATH,
  parseMergeIngress,
  queryMergeAllowed,
  queryMergeGate,
  recordVerdict,
} from '../../scripts/lib/review-gate.mjs';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

// Scratch repo with an initial commit on main and a simulated origin/main.
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'merge-gate-test-'));
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

// Branch off main carrying `nLines` of gated (scripts/*.js) change, then return
// to main — exactly the state a worktree session is in when it merges.
function makeBranch(repo, branch, nLines, file = 'scripts/feature.js') {
  git(repo, 'checkout', '-q', '-b', branch);
  mkdirSync(join(repo, file.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(join(repo, file),
    Array.from({ length: nLines }, (_, i) => `console.log(${i}); // ${branch}`).join('\n') + '\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `${branch}: ${nLines} lines`);
  git(repo, 'checkout', '-q', 'main');
  return branch;
}

// ── parseMergeIngress: what counts as "a merge into main" ───────────────────

test('parse: standalone `git merge X` on main targets main', () => {
  const r = parseMergeIngress('git merge worktree-feature', { currentBranch: 'main' });
  assert.equal(r.isMerge, true);
  assert.equal(r.targetsMain, true);
  assert.deepEqual(r.sources, ['worktree-feature']);
  assert.equal(r.via, 'git-merge');
});

test('parse: `git merge X` on a worktree branch does NOT target main', () => {
  // ACCEPTANCE 5: merges not targeting main are untouched. Sessions merge
  // origin/main INTO their branch constantly; gating that would be nonsense.
  const r = parseMergeIngress('git merge origin/main --no-edit', { currentBranch: 'worktree-foo' });
  assert.equal(r.targetsMain, false);
  assert.equal(r.destination, 'worktree-foo');
});

test('parse: `git checkout main && git merge X` targets main from any branch', () => {
  // The documented flow. At hook time the repo is still on the worktree
  // branch, so the CURRENT branch cannot reveal the destination — only the
  // checkout token in the same command can.
  const r = parseMergeIngress('git checkout main && git pull && git merge worktree-feature --no-edit',
    { currentBranch: 'worktree-feature' });
  assert.equal(r.targetsMain, true);
  assert.deepEqual(r.sources, ['worktree-feature']);
});

test('parse: `git switch main && git merge X` is equivalent to checkout', () => {
  const r = parseMergeIngress('git switch main && git merge feat', { currentBranch: 'feat' });
  assert.equal(r.targetsMain, true);
});

test('parse: checkout to a NON-main branch retargets away from main', () => {
  const r = parseMergeIngress('git checkout staging && git merge feat', { currentBranch: 'main' });
  assert.equal(r.targetsMain, false);
  assert.equal(r.destination, 'staging');
});

test('parse: `git merge --abort/--continue/--quit` is never an ingress', () => {
  // Blocking these would strand the shared main worktree mid-conflict — the
  // task #916 failure mode, strictly worse than the problem this gate solves.
  for (const flag of ['--abort', '--continue', '--quit']) {
    const r = parseMergeIngress(`git merge ${flag}`, { currentBranch: 'main' });
    assert.equal(r.isMerge, false, `git merge ${flag} must not be gated`);
  }
});

test('parse: `git pull` is not a merge ingress', () => {
  const r = parseMergeIngress('git pull origin main', { currentBranch: 'main' });
  assert.equal(r.isMerge, false);
});

test('parse: -m value is not mistaken for the merge source', () => {
  const r = parseMergeIngress('git merge -m "merge the feature branch" feat', { currentBranch: 'main' });
  assert.deepEqual(r.sources, ['feat']);
});

test('parse: git global options are skipped when locating the subcommand', () => {
  const r = parseMergeIngress('git -C /tmp/repo merge feat --no-ff', { currentBranch: 'main' });
  assert.equal(r.targetsMain, true);
  assert.deepEqual(r.sources, ['feat']);
});

test('parse: subshell parens do not corrupt the source ref', () => {
  // infra-review-scope's shellSegments splits on && but not on parens, so
  // `(cd x && git merge feat)` leaves a trailing `)` on the ref token.
  const r = parseMergeIngress('(cd /repo && git merge feat)', { currentBranch: 'main' });
  assert.deepEqual(r.sources, ['feat'], 'trailing paren must be stripped from the ref');
});

test('parse: octopus merge reports every source', () => {
  const r = parseMergeIngress('git merge feat-a feat-b', { currentBranch: 'main' });
  assert.deepEqual(r.sources, ['feat-a', 'feat-b']);
});

test('parse: prose mentioning merge is not an ingress', () => {
  const r = parseMergeIngress('echo "about to merge things" && ls', { currentBranch: 'main' });
  assert.equal(r.isMerge, false);
});

test('parse: `bash -c` payload bails rather than guessing (fail open)', () => {
  const r = parseMergeIngress(`bash -c 'git merge feat'`, { currentBranch: 'main' });
  assert.equal(r.isMerge, false);
});

// ── parseMergeIngress: the wrapper script, the REAL call site ───────────────

test('parse: merge-worktree-to-main.sh with an explicit branch targets main', () => {
  // This command contains no `git merge` token at all, and its name has no
  // "push" in it — so neither the push gate's awk block nor PUSH_INGRESS_RE
  // sees it. It is the ingress this gate exists for.
  const r = parseMergeIngress('scripts/merge-worktree-to-main.sh worktree-feature',
    { currentBranch: 'worktree-feature' });
  assert.equal(r.isMerge, true);
  assert.equal(r.targetsMain, true);
  assert.equal(r.via, 'wrapper');
  assert.deepEqual(r.sources, ['worktree-feature']);
});

test('parse: wrapper with no branch arg defaults to the current branch', () => {
  const r = parseMergeIngress('bash scripts/merge-worktree-to-main.sh', { currentBranch: 'worktree-foo' });
  assert.deepEqual(r.sources, ['worktree-foo']);
  assert.equal(r.targetsMain, true);
});

test('parse: wrapper `-- files` list is not read as the branch', () => {
  const r = parseMergeIngress('scripts/merge-worktree-to-main.sh -- scripts/a.js scripts/b.js',
    { currentBranch: 'worktree-foo' });
  assert.deepEqual(r.sources, ['worktree-foo'], 'the file list must not be taken as the source branch');
});

test('parse: DRY_RUN=1 env prefix still gates (it skips the push, not the merge)', () => {
  const r = parseMergeIngress('DRY_RUN=1 ./scripts/merge-worktree-to-main.sh wt-x -- scripts/a.js',
    { currentBranch: 'main' });
  assert.equal(r.targetsMain, true);
  assert.deepEqual(r.sources, ['wt-x']);
});

test('parse: absolute-path wrapper invocation is recognised', () => {
  const r = parseMergeIngress('/Users/x/Broadwayscore/scripts/merge-worktree-to-main.sh wt-y',
    { currentBranch: 'main' });
  assert.equal(r.targetsMain, true);
  assert.deepEqual(r.sources, ['wt-y']);
});

test('parse: wrapper invoked with main as source is not gated (the wrapper refuses it)', () => {
  const r = parseMergeIngress('scripts/merge-worktree-to-main.sh', { currentBranch: 'main' });
  assert.equal(r.isMerge, false);
});

// ── the decision: queryMergeAllowed / queryMergeGate ────────────────────────

test('ACCEPTANCE 1: merging >30 unreviewed gated lines into main is BLOCKED', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  makeBranch(repo, 'worktree-big', 60);
  const r = queryMergeGate({ repoRoot: repo, ledgerRoot: repo, command: 'git merge worktree-big', currentBranch: 'main' });
  assert.equal(r.allowed, false);
  assert.equal(r.blockingRef, 'worktree-big');
  assert.ok(r.gatedLines > GATE_LINE_BUDGET, `expected >${GATE_LINE_BUDGET} gated lines, got ${r.gatedLines}`);
  assert.match(r.reason, /no review verdict/);
});

test('ACCEPTANCE 2: the same merge with a fresh pass verdict is ALLOWED', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  makeBranch(repo, 'worktree-big', 60);
  // A verdict recorded on the BRANCH (what /ship-check does before merging).
  const rec = recordVerdict({ repoRoot: repo, ledgerRoot: repo, reviewer: 'ship-check', result: 'pass', ref: 'worktree-big' });
  assert.equal(rec.recorded, true);
  const r = queryMergeGate({ repoRoot: repo, ledgerRoot: repo, command: 'git merge worktree-big', currentBranch: 'main' });
  assert.equal(r.allowed, true, `expected allowed, got ${JSON.stringify(r)}`);
});

test('a FAIL verdict does not unlock the merge', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  makeBranch(repo, 'worktree-big', 60);
  recordVerdict({ repoRoot: repo, ledgerRoot: repo, reviewer: 'ship-check', result: 'fail', ref: 'worktree-big' });
  const r = queryMergeGate({ repoRoot: repo, ledgerRoot: repo, command: 'git merge worktree-big', currentBranch: 'main' });
  assert.equal(r.allowed, false);
});

test('an under-budget merge needs no verdict', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  makeBranch(repo, 'worktree-small', GATE_LINE_BUDGET - 5);
  const r = queryMergeGate({ repoRoot: repo, ledgerRoot: repo, command: 'git merge worktree-small', currentBranch: 'main' });
  assert.equal(r.allowed, true);
});

test('ACCEPTANCE 5: an unreviewed merge into a NON-main branch is untouched', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  makeBranch(repo, 'worktree-big', 60);
  const r = queryMergeGate({ repoRoot: repo, ledgerRoot: repo, command: 'git merge worktree-big', currentBranch: 'staging' });
  assert.equal(r.allowed, true);
  assert.equal(r.ingress.targetsMain, false);
});

test('the wrapper ingress reaches the same block as a bare git merge', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  makeBranch(repo, 'worktree-big', 60);
  const r = queryMergeGate({
    repoRoot: repo, ledgerRoot: repo,
    command: 'bash scripts/merge-worktree-to-main.sh worktree-big',
    currentBranch: 'worktree-big',
  });
  assert.equal(r.allowed, false, 'the wrapper is the primary call site — it must gate');
  assert.equal(r.ingress.via, 'wrapper');
});

test('the strictest source wins on an octopus merge', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  makeBranch(repo, 'worktree-small', GATE_LINE_BUDGET - 5, 'scripts/small.js');
  makeBranch(repo, 'worktree-big', 60, 'scripts/big.js');
  const r = queryMergeGate({
    repoRoot: repo, ledgerRoot: repo,
    command: 'git merge worktree-small worktree-big', currentBranch: 'main',
  });
  assert.equal(r.allowed, false);
  assert.equal(r.blockingRef, 'worktree-big');
});

// ── fail-open: the property that must never regress ─────────────────────────

test('ACCEPTANCE 4: an unresolvable merge source FAILS OPEN', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const r = queryMergeAllowed({ repoRoot: repo, ledgerRoot: repo, sources: ['no-such-branch'] });
  assert.equal(r.allowed, true);
  assert.match(r.evaluated[0].reason, /does not resolve/);
});

test('ACCEPTANCE 4: an UNREADABLE ledger FAILS OPEN (never wedges the merge)', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  makeBranch(repo, 'worktree-big', 60);
  // Write a ledger, then make it unreadable. readLedger's readFileSync throws;
  // queryMergeAllowed's per-source try/catch must turn that into allowed:true,
  // NOT into a block and NOT into a crash.
  const ledger = join(repo, LEDGER_REL_PATH);
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(ledger, '{"reviewer":"ship-check","result":"pass"}\n');
  chmodSync(ledger, 0o000);
  let readable = true;
  try { readFileSync(ledger, 'utf8'); } catch { readable = false; }
  // Running as root (some CI images) ignores the mode bits — skip rather than
  // assert a property the fixture failed to create.
  if (readable) {
    chmodSync(ledger, 0o644);
    t.skip('ledger still readable after chmod 000 (running as root?) — fixture could not induce the error');
    return;
  }
  const r = queryMergeAllowed({ repoRoot: repo, ledgerRoot: repo, sources: ['worktree-big'] });
  chmodSync(ledger, 0o644);
  assert.equal(r.allowed, true, 'an unreadable ledger must fail OPEN, not block every session');
});

test('ACCEPTANCE 4: a nonexistent repo root FAILS OPEN', () => {
  const r = queryMergeGate({
    repoRoot: '/nonexistent/path/for/merge/gate/test',
    ledgerRoot: '/nonexistent/path/for/merge/gate/test',
    command: 'git merge worktree-big', currentBranch: 'main',
  });
  assert.equal(r.allowed, true);
});

test('ACCEPTANCE 4: an empty/garbage command FAILS OPEN', () => {
  for (const cmd of ['', '   ', 'git', 'git merge']) {
    const r = queryMergeGate({ repoRoot: process.cwd(), command: cmd, currentBranch: 'main' });
    assert.equal(r.allowed, true, `command ${JSON.stringify(cmd)} must fail open`);
  }
});

// ── the ledger ancestor scan (shared with the push gate) ───────────────────

test('a ledger head whose object no longer exists is a non-match, not a crash', (t) => {
  // Guards the ancestorSet() change in queryPushAllowed, which BOTH gates use.
  // Measured on the real repo 2026-08-12: 1044 of 1079 recorded heads were
  // objects that no longer exist (worktree branches deleted and pruned), and
  // `merge-base --is-ancestor` cost ~589ms EACH to fail on them — a ~10.6
  // minute scan. Replacing it with one `git rev-list` set must keep the answer
  // identical: a head that isn't a real object is simply not an ancestor.
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  makeBranch(repo, 'worktree-big', 60);
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, LEDGER_REL_PATH), JSON.stringify({
    ts: new Date().toISOString(), reviewer: 'ship-check', result: 'pass',
    branch: 'gone', head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    diffHash: 'notarealhash1234', gatedLines: 10,
  }) + '\n');
  const r = queryMergeAllowed({ repoRoot: repo, ledgerRoot: repo, sources: ['worktree-big'] });
  assert.equal(r.allowed, false, 'a phantom head must not satisfy the gate');
  assert.match(r.reason, /no review verdict/,
    'a non-existent head is not an ancestor, so it cannot even register as a STALE verdict');
});

test('a real ancestor head still matches through the rev-list set', (t) => {
  // The other half of the equivalence: the fast path must still FIND verdicts.
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  makeBranch(repo, 'worktree-big', 60);
  const rec = recordVerdict({ repoRoot: repo, ledgerRoot: repo, reviewer: 'ship-check', result: 'pass', ref: 'worktree-big' });
  // Add a few more gated lines so the exact-hash arm can't be what saves it —
  // this must pass via the ancestor/fixup-drift arm specifically. Check the
  // branch out BEFORE writing: makeBranch leaves the tree on main, where
  // scripts/feature.js does not exist, so writing it there first would make
  // the checkout refuse to clobber an untracked file.
  git(repo, 'checkout', '-q', 'worktree-big');
  writeFileSync(join(repo, 'scripts/feature.js'),
    Array.from({ length: 70 }, (_, i) => `console.log(${i}); // fixup`).join('\n') + '\n');
  // `git add scripts/feature.js`, NOT `git add -A`: the ledger this test just
  // wrote lives at .claude/review-verdicts.jsonl and is UNTRACKED, so `-A`
  // would commit it onto the branch and the checkout back to main would then
  // delete it — the verdict would silently vanish and this test would "fail"
  // for a reason that has nothing to do with the gate.
  git(repo, 'add', 'scripts/feature.js');
  git(repo, 'commit', '-q', '-m', 'review fixups');
  git(repo, 'checkout', '-q', 'main');
  const r = queryMergeAllowed({ repoRoot: repo, ledgerRoot: repo, sources: ['worktree-big'] });
  assert.equal(r.allowed, true, `fixup drift after ${rec.entry.head.slice(0, 8)} must still be recognised`);
  assert.equal(r.evaluated[0].via, 'fixup-drift');
});

test('queryMergeAllowed never throws on a malformed sources argument', () => {
  for (const sources of [null, undefined, 'not-an-array', []]) {
    const r = queryMergeAllowed({ repoRoot: process.cwd(), sources });
    assert.equal(r.allowed, true);
  }
});
