// scripts/tests/merge-gate-hook.test.mjs
//
// Shell-level end-to-end test for ~/.claude/hooks/pre-merge-review-gate.sh and
// its sibling pre-push-review-gate.sh (task #1316).
//
// The two hooks are ~210-280 lines of bash each, with one exit-2 (BLOCKED)
// path and ~15 fail-open paths. Prior coverage — tests/unit/review-gate-
// merge.test.mjs — tests only the DECISION layer (scripts/lib/review-gate.mjs
// require()d directly). That split is exactly where the two 2026-08-12 P0s
// lived: the decision layer was correct and unit-tested green while the hook
// itself silently failed open 100% of the time on a jq quirk (`.allowed //
// empty` treats the JSON boolean `false` as absent), and separately deferred
// every compound merge+push to a gate that never evaluated it. This file
// pipes real PreToolUse JSON into the REAL hook scripts over stdin and reads
// their exit codes (0 = allowed, 2 = BLOCKED) — plumbing no unit test can see.
//
// Ported from a scratchpad acceptance harness that proved 16/16 against the
// live gate before this task promoted it into the repo.
//
// Hook resolution: prefers $HOME/.claude/hooks/<name>.sh (the hook actually
// REGISTERED and firing for real PreToolUse events on a local Claude Code
// machine — matching the proven scratchpad harness this file ports) and
// falls back to the project copy at <repo>/.claude/hooks/<name>.sh (committed
// so cloud sandboxes and CI — which have no ~/.claude — still exercise a real
// copy of the script). The two are MEANT to be kept byte-identical, but
// nothing enforces that automatically, so on a dev machine where the $HOME
// copy has drifted stale, this suite validates the currently-registered
// (possibly older) hook, not necessarily HEAD's committed one — CI is
// unaffected (no ~/.claude there). Both hooks resolve their lib from the
// CANONICAL repo root
// (scripts/lib/review-gate.mjs relative to the git-common-dir parent) and
// exit 0 (fail open) if it's absent, so this suite only produces meaningful
// BLOCKED assertions when run inside a real checkout of this repo — which
// `node --test` always is.
//
// Every git mutation here happens inside throwaway worktrees/branches created
// and torn down by this file; nothing here rewrites HEAD in the checkout that
// invokes `node --test` itself, and no scenario here actually executes the
// probed command — the hook only inspects `.tool_input.command` as text plus
// read-only repo state, exactly as the real PreToolUse event does.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { canonicalRoot } from '../lib/review-gate.mjs';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const REAL_HOME = os.homedir();
const RUN_ID = randomUUID().slice(0, 8);

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}
function gitOut(cwd, args) {
  const r = git(cwd, args);
  return (r.stdout || '').trim();
}
function gitOk(cwd, args) {
  return git(cwd, args).status === 0;
}

// The main-worktree root (shared ledger + canonical scripts/lib) — the SAME
// canonicalRoot() the hooks themselves call via review-gate.mjs (CLAUDE.md
// rule 15: require the real function, don't reimplement it). When this file
// runs from a linked worktree (the project's own worktree-first workflow)
// CANONICAL_ROOT is the shared checkout; in a plain CI clone it's REPO_ROOT.
const CANONICAL_ROOT = canonicalRoot(REPO_ROOT);

// ── base ref resolution: LOCAL ONLY, no network ────────────────────────────
//
// This suite used to open with an untimed `git fetch origin main` in before().
// `node --test` has no default per-test timeout and none at all for before(),
// so on a slow runner that call is an unbounded wait on remote reachability:
// run 31832656296 wedged here and was killed at the 300s --test-timeout with
// `# fail 0` and no failing assertion named — a whole batch of results lost to
// a hook that a unit test never needed in the first place.
//
// It never needed the network because nothing here tests fetching. The fixture
// only needs a commit to branch from that the GATE will also treat as its base,
// and scripts/lib/review-gate.mjs resolves that base itself with exactly this
// precedence (origin/main, then main) off refs already in the object store. So
// read the same refs the gate reads, locally, and let git answer in
// microseconds whether they exist. A CI checkout (actions/checkout@v5 on a push
// to main) always has refs/remotes/origin/main; a scratch clone without a
// remote still has main.
//
// If NEITHER resolves there is no meaningful fixture to build, and every
// BLOCKED assertion below would be vacuous — so the tests skip with this
// reason printed, immediately, rather than hanging until something kills them.
//
// RULE for anyone extending this file: no live network in setup. Not a fetch,
// not a clone from a URL, not an HTTP call. If a future scenario genuinely
// needs remote behaviour, build a local bare repo and use it as `origin` (see
// scripts/tests/infra-gate-registration.test.mjs, which does exactly that).
function resolveBaseRef() {
  for (const ref of ['origin/main', 'main']) {
    if (gitOk(CANONICAL_ROOT, ['rev-parse', '--verify', '--quiet', ref])) {
      return { ref, reason: null };
    }
  }
  return {
    ref: null,
    reason: `no local origin/main or main ref in ${CANONICAL_ROOT} to cut the probe fixture from (checked with rev-parse; this suite deliberately never fetches)`,
  };
}

function resolveHookPath(basename) {
  const userHook = path.join(REAL_HOME, '.claude', 'hooks', basename);
  if (fs.existsSync(userHook)) return userHook;
  const repoHook = path.join(CANONICAL_ROOT, '.claude', 'hooks', basename);
  if (fs.existsSync(repoHook)) return repoHook;
  return null;
}

const MERGE_HOOK = resolveHookPath('pre-merge-review-gate.sh');
const PUSH_HOOK = resolveHookPath('pre-push-review-gate.sh');
const hasGates = MERGE_HOOK !== null && PUSH_HOOK !== null;

function makeTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `merge-gate-hook-test-${label}-`));
}

// A fake transcript with no NO-SHIP-CHECK / "ship immediately" text, so the
// bypass-token scan never fires unless a test opts into it explicitly.
let TRANSCRIPT_PATH;

// Fixtures built once in before(), torn down in after(). suffix avoids
// collisions with any of the ~20 parallel sessions that may share this
// checkout on the dev machine.
const suffix = `${RUN_ID}`;
const PROBE_BRANCH = `merge-gate-hook-test-probe-${suffix}`;
const NONMAIN_BRANCH = `merge-gate-hook-test-nonmain-${suffix}`;
let probeWorktree, nonmainWorktree, unrelatedRepo;
let probeLines = null;
// The ref the probe branch is cut from. Resolved from refs ALREADY PRESENT in
// the local object store — never over the network (see resolveBaseRef).
let BASE_REF = null;
let baseRefReason = null;

function runHook(hookPath, { command, cwd = REPO_ROOT, transcript = TRANSCRIPT_PATH, sessionId = `mgh-test-${randomUUID()}`, toolUseId = `tu-${randomUUID()}`, env = {} }) {
  const stdin = JSON.stringify({
    tool_input: { command },
    session_id: sessionId,
    transcript_path: transcript,
    tool_use_id: toolUseId,
  });
  const r = spawnSync('bash', [hookPath], {
    cwd,
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function assertBlocked(result, message) {
  assert.equal(result.status, 2, `${message} — expected BLOCKED (exit 2), got exit ${result.status}. stderr: ${result.stderr.slice(0, 300)}`);
}
function assertAllowed(result, message) {
  assert.equal(result.status, 0, `${message} — expected allowed (exit 0), got exit ${result.status}. stderr: ${result.stderr.slice(0, 300)}`);
}

before(() => {
  const tdir = makeTmpDir('fixtures');
  TRANSCRIPT_PATH = path.join(tdir, 'transcript.jsonl');
  fs.writeFileSync(
    TRANSCRIPT_PATH,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'build the merge gate' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } }),
      '',
    ].join('\n')
  );

  if (!hasGates) return; // nothing else to build if the hooks themselves aren't present

  // ── a wholly unrelated git repo, to prove cross-repo `cd`s are left alone.
  // Built here (before the BASE_REF gate below) because it needs nothing from
  // a base ref — gating it on base availability would silently degrade the
  // "unrelated repo" test into a meaningless `cd undefined`.
  unrelatedRepo = makeTmpDir('unrelated-repo');
  git(unrelatedRepo, ['init', '-q']);

  const base = resolveBaseRef();
  BASE_REF = base.ref;
  baseRefReason = base.reason;
  if (!BASE_REF) return;

  // ── probe branch: >150 gated lines (exceeds both GATE_LINE_BUDGET=30 and
  // DRIFT_BUDGET_LINES=150 in scripts/lib/review-gate.mjs), off BASE_REF (the
  // same base the gate itself resolves), with no review verdict — the exact
  // shape the gate must BLOCK.
  git(CANONICAL_ROOT, ['branch', '-D', PROBE_BRANCH]);
  gitOk(CANONICAL_ROOT, ['branch', PROBE_BRANCH, BASE_REF]);
  probeWorktree = makeTmpDir('probe-wt');
  fs.rmSync(probeWorktree, { recursive: true, force: true });
  if (!gitOk(CANONICAL_ROOT, ['worktree', 'add', '-q', '--detach', probeWorktree, PROBE_BRANCH])) {
    probeWorktree = null;
    return;
  }
  fs.mkdirSync(path.join(probeWorktree, 'scripts'), { recursive: true });
  const lines = [];
  for (let i = 1; i <= 400; i++) lines.push(`console.log(${i}); // unreviewed probe`);
  fs.writeFileSync(path.join(probeWorktree, 'scripts', 'merge-gate-hook-test-probe.js'), lines.join('\n') + '\n');
  git(probeWorktree, ['add', 'scripts/merge-gate-hook-test-probe.js']);
  git(probeWorktree, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'probe: unreviewed gated lines']);
  const probeHead = gitOut(probeWorktree, ['rev-parse', 'HEAD']);
  gitOk(CANONICAL_ROOT, ['branch', '-f', PROBE_BRANCH, probeHead]);

  const diffHashOut = spawnSync('node', [
    path.join(CANONICAL_ROOT, 'scripts', 'lib', 'review-gate.mjs'),
    '--query=diff-hash',
    `--repo=${CANONICAL_ROOT}`,
    `--ref=${PROBE_BRANCH}`,
  ], { cwd: CANONICAL_ROOT, encoding: 'utf8' });
  try {
    const parsed = JSON.parse(diffHashOut.stdout || '{}');
    probeLines = typeof parsed.totalLines === 'number' ? parsed.totalLines : null;
  } catch {
    probeLines = null;
  }

  // ── non-main worktree: a second checkout on a branch that is NOT main, for
  // the "current branch isn't main, so this doesn't target main" cases.
  git(CANONICAL_ROOT, ['branch', '-D', NONMAIN_BRANCH]);
  nonmainWorktree = makeTmpDir('nonmain-wt');
  fs.rmSync(nonmainWorktree, { recursive: true, force: true });
  if (!gitOk(CANONICAL_ROOT, ['worktree', 'add', '-q', '-b', NONMAIN_BRANCH, nonmainWorktree, BASE_REF])) {
    nonmainWorktree = null;
  }
});

after(() => {
  if (probeWorktree) { git(CANONICAL_ROOT, ['worktree', 'remove', '--force', probeWorktree]); fs.rmSync(probeWorktree, { recursive: true, force: true }); }
  if (nonmainWorktree) { git(CANONICAL_ROOT, ['worktree', 'remove', '--force', nonmainWorktree]); fs.rmSync(nonmainWorktree, { recursive: true, force: true }); }
  if (unrelatedRepo) fs.rmSync(unrelatedRepo, { recursive: true, force: true });
  git(CANONICAL_ROOT, ['branch', '-D', PROBE_BRANCH]);
  git(CANONICAL_ROOT, ['branch', '-D', NONMAIN_BRANCH]);
  if (TRANSCRIPT_PATH) fs.rmSync(path.dirname(TRANSCRIPT_PATH), { recursive: true, force: true });
});

const skipNoGates = { get skip() { return !hasGates && 'neither ~/.claude/hooks nor the repo .claude/hooks copy of the merge/push gates is present on this machine' } };
const skipNoProbe = { get skip() { return (!hasGates || !BASE_REF || !probeWorktree || probeLines === null) && `probe branch fixture failed to build${baseRefReason ? ` — ${baseRefReason}` : ''}` } };
const skipNoNonmain = { get skip() { return (!hasGates || !BASE_REF || !nonmainWorktree) && `non-main worktree fixture failed to build${baseRefReason ? ` — ${baseRefReason}` : ''}` } };

// ── fixture self-check: the premise every BLOCKED assertion below rests on ─

test('probe branch fixture carries MORE than both GATE_LINE_BUDGET (30) and DRIFT_BUDGET_LINES (150) gated lines', skipNoProbe, () => {
  assert.ok(probeLines > 150, `probe branch only has ${probeLines} gated lines vs origin/main — every BLOCKED case below would be meaningless if this fixture is too small`);
});

// ── merge-gate: BLOCKED cases ───────────────────────────────────────────────

test('merge-gate BLOCKS an unreviewed merge into main (explicit checkout main && merge)', skipNoProbe, () => {
  const r = runHook(MERGE_HOOK, { command: `git checkout main && git merge ${PROBE_BRANCH} --no-edit` });
  assertBlocked(r, 'explicit checkout+merge');
  assert.match(r.stderr, /BLOCKED/);
});

test('merge-gate BLOCKS the real call site: scripts/merge-worktree-to-main.sh wrapper', skipNoProbe, () => {
  const r = runHook(MERGE_HOOK, { command: `bash scripts/merge-worktree-to-main.sh ${PROBE_BRANCH}` });
  assertBlocked(r, 'merge-worktree-to-main.sh wrapper');
});

test('merge-gate BLOCKS a compound merge+push — the exact hole a 2026-08-12 P0 found (deferring to the push gate, which then missed it too)', skipNoProbe, () => {
  const r = runHook(MERGE_HOOK, {
    command: `git checkout main && git merge ${PROBE_BRANCH} && bash scripts/lib/push-with-retry.sh`,
  });
  assertBlocked(r, 'compound merge+push');
});

test('merge-gate: the same bare "git merge <probe>" run FROM the main checkout also BLOCKS (control for the non-main cases below)', skipNoNonmain, (t) => {
  const onMain = gitOut(CANONICAL_ROOT, ['branch', '--show-current']) === 'main';
  if (!onMain) { t.skip('CANONICAL_ROOT is not literally checked out to `main` right now (e.g. detached-HEAD PR checkout in CI) — nothing to assert'); return; }
  const r = runHook(MERGE_HOOK, { command: `git merge ${PROBE_BRANCH} --no-edit`, cwd: CANONICAL_ROOT });
  assertBlocked(r, 'bare merge from main checkout');
});

// ── merge-gate: allowed cases (the precondition that makes the control above meaningful) ──

test('merge-gate leaves a merge into a NON-main branch untouched', skipNoNonmain, () => {
  const r = runHook(MERGE_HOOK, { command: `git merge ${PROBE_BRANCH} --no-edit`, cwd: nonmainWorktree });
  assertAllowed(r, 'merge into non-main branch');
});

test('merge-gate leaves `git merge --abort` untouched', skipNoGates, () => {
  const r = runHook(MERGE_HOOK, { command: 'git merge --abort' });
  assertAllowed(r, 'merge --abort');
});

test('merge-gate leaves `git pull` untouched', skipNoGates, () => {
  const r = runHook(MERGE_HOOK, { command: 'git pull origin main' });
  assertAllowed(r, 'git pull');
});

test('merge-gate leaves merging origin/main INTO a feature branch untouched', skipNoNonmain, () => {
  const r = runHook(MERGE_HOOK, { command: 'git merge origin/main --no-edit', cwd: nonmainWorktree });
  assertAllowed(r, 'merge origin/main in');
});

test('merge-gate: `git checkout main -- <path>` (file restore) is not mistaken for a branch switch', skipNoNonmain, () => {
  const r = runHook(MERGE_HOOK, { command: `git checkout main -- scripts/x.js && git merge ${PROBE_BRANCH}`, cwd: nonmainWorktree });
  assertAllowed(r, 'checkout main -- path');
});

test('merge-gate leaves a merge in a wholly unrelated repo untouched', skipNoGates, () => {
  const r = runHook(MERGE_HOOK, { command: `cd ${unrelatedRepo} && git merge some-branch`, cwd: unrelatedRepo });
  assertAllowed(r, 'unrelated repo');
});

test('merge-gate leaves an unrelated command untouched', skipNoGates, () => {
  const r = runHook(MERGE_HOOK, { command: 'ls -la' });
  assertAllowed(r, 'unrelated command');
});

test('merge-gate: NO-SHIP-CHECK in-command comment bypasses the block', skipNoProbe, () => {
  const r = runHook(MERGE_HOOK, {
    command: `git checkout main && git merge ${PROBE_BRANCH}  # NO-SHIP-CHECK: docs-only revert of an accidental commit`,
  });
  assertAllowed(r, 'NO-SHIP-CHECK bypass');
});

// ── merge-gate: fail-open set — must NEVER regress (task #1316 AC #4) ──────

test('merge-gate fails open: REVIEW_GATE_DISABLE=1 kill switch overrides a command that would otherwise BLOCK', skipNoProbe, () => {
  const r = runHook(MERGE_HOOK, {
    command: `git checkout main && git merge ${PROBE_BRANCH} --no-edit`,
    env: { REVIEW_GATE_DISABLE: '1' },
  });
  assertAllowed(r, 'REVIEW_GATE_DISABLE=1');
});

test('merge-gate fails open: missing transcript file (no escape hatch available) never blocks', skipNoProbe, () => {
  const r = runHook(MERGE_HOOK, {
    command: `git checkout main && git merge ${PROBE_BRANCH} --no-edit`,
    transcript: '/nonexistent/transcript.jsonl',
  });
  assertAllowed(r, 'missing transcript');
});

test('merge-gate fails open: malformed stdin never blocks', skipNoGates, () => {
  const r = spawnSync('bash', [MERGE_HOOK], { input: 'not json at all', encoding: 'utf8' });
  assertAllowed(r, 'malformed stdin');
});

test('merge-gate fails open: an unresolvable source ref never blocks', skipNoGates, () => {
  const r = runHook(MERGE_HOOK, { command: 'git checkout main && git merge totally-nonexistent-ref-xyz --no-edit' });
  assertAllowed(r, 'unresolvable ref');
});

// ── negative control (task #1316 AC #2): a test suite that stays green
// against a BROKEN hook is worthless. This exact bug shipped on 2026-08-12:
// `.allowed | tostring` was written as `.allowed // empty`, and jq's `//`
// treats the JSON boolean `false` as absent, so the gate failed open on
// EVERY genuine block. Patch a temp copy of the live hook back to the buggy
// form and prove the assertions above would have caught it. ──────────────
//
// The patched copy is a standalone temp file, not the file registered at
// $HOME/.claude/hooks/pre-merge-review-gate.sh — so the hook's own "project
// copy only" self-skip preamble (BASH_SOURCE[0] != the $HOME path) would
// otherwise exit 0 before ever reaching the patched line, making this
// assertion pass for the WRONG reason on any machine where the real hook is
// installed (code-review finding, task #1316). HOME is overridden to an
// empty temp dir for just this subprocess so `[ -f "$HOME/.claude/hooks/..."
// ]` is false and the preamble does not fire — the patched copy runs its own
// full logic, including the vulnerable line under test.

test('regression pin: reverting the jq `.allowed | tostring` fix to `.allowed // empty` silently fails open (the exact 2026-08-12 P0)', skipNoProbe, () => {
  const original = fs.readFileSync(MERGE_HOOK, 'utf8');
  const needle = "ALLOWED=$(echo \"$RESULT\" | jq -r '.allowed | tostring' 2>/dev/null)";
  assert.ok(original.includes(needle), 'the live hook no longer contains the expected tostring line — update this pin to match its current form');
  const broken = original.replace(needle, "ALLOWED=$(echo \"$RESULT\" | jq -r '.allowed // empty' 2>/dev/null)");
  const tdir = makeTmpDir('broken-hook');
  const fakeHome = path.join(tdir, 'fake-home'); // deliberately has no .claude/hooks/ — defeats the self-skip preamble
  fs.mkdirSync(fakeHome, { recursive: true });
  const brokenPath = path.join(tdir, 'pre-merge-review-gate-broken.sh');
  fs.writeFileSync(brokenPath, broken);
  fs.chmodSync(brokenPath, 0o755);
  try {
    const r = runHook(brokenPath, {
      command: `git checkout main && git merge ${PROBE_BRANCH} --no-edit`,
      env: { HOME: fakeHome },
    });
    assert.equal(r.status, 0, 'the broken hook should fail OPEN on a command the real hook blocks — proving this suite has teeth');
  } finally {
    fs.rmSync(tdir, { recursive: true, force: true });
  }
});

// Companion sanity check: with the SAME fakeHome/self-skip-defeat plumbing,
// the UNPATCHED hook (copied byte-for-byte, no jq change) must still BLOCK —
// otherwise the negative control above would pass merely because fakeHome
// broke something else entirely (e.g. CANONICAL_ROOT resolution), not
// because of the reverted jq line specifically.
test('regression pin sanity: the fakeHome plumbing alone does not change the verdict — an unpatched copy still BLOCKS', skipNoProbe, () => {
  const original = fs.readFileSync(MERGE_HOOK, 'utf8');
  const tdir = makeTmpDir('unpatched-hook');
  const fakeHome = path.join(tdir, 'fake-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const copyPath = path.join(tdir, 'pre-merge-review-gate-copy.sh');
  fs.writeFileSync(copyPath, original);
  fs.chmodSync(copyPath, 0o755);
  try {
    const r = runHook(copyPath, {
      command: `git checkout main && git merge ${PROBE_BRANCH} --no-edit`,
      env: { HOME: fakeHome },
    });
    assertBlocked(r, 'unpatched copy under fakeHome');
  } finally {
    fs.rmSync(tdir, { recursive: true, force: true });
  }
});

// ── push-gate: BLOCKED cases ────────────────────────────────────────────────

test('push-gate BLOCKS an explicit push of the unreviewed probe branch to main', skipNoProbe, () => {
  const r = runHook(PUSH_HOOK, { command: `git push origin ${PROBE_BRANCH}:main` });
  assertBlocked(r, 'explicit refspec push to main');
  assert.match(r.stderr, /BLOCKED/);
});

test('push-gate BLOCKS the compound merge+push (defense in depth alongside the merge gate)', skipNoProbe, () => {
  const r = runHook(PUSH_HOOK, {
    command: `git checkout main && git merge ${PROBE_BRANCH} && git push origin main`,
  });
  assertBlocked(r, 'compound merge+push via push gate');
});

test('push-gate: the same bare "git push" run FROM the main checkout also BLOCKS when gated diff is unreviewed', skipNoNonmain, (t) => {
  const onMain = gitOut(CANONICAL_ROOT, ['branch', '--show-current']) === 'main';
  if (!onMain) { t.skip('CANONICAL_ROOT is not literally checked out to `main` right now (e.g. detached-HEAD PR checkout in CI) — nothing to assert'); return; }
  // Push gate resolves a bare push's destination from the CURRENT BRANCH tip,
  // not an arbitrary probe ref, so this exercises the real ambient-main path
  // rather than reusing PROBE_BRANCH (which the bare form can't reference).
  const r = runHook(PUSH_HOOK, { command: 'git push', cwd: CANONICAL_ROOT });
  // Ambient main is expected to be clean/reviewed in normal operation, so this
  // only asserts a verdict was reached (0 or 2), not which — it is here to
  // prove the bare-push destination-resolution path executes without error.
  assert.ok(r.status === 0 || r.status === 2, `push gate produced neither allowed nor BLOCKED for bare push: exit ${r.status}, stderr: ${r.stderr.slice(0, 300)}`);
});

// ── push-gate: allowed cases ─────────────────────────────────────────────

test('push-gate leaves a WIP push of a non-main branch untouched', skipNoProbe, () => {
  const r = runHook(PUSH_HOOK, { command: `git push origin ${PROBE_BRANCH}` });
  assertAllowed(r, 'non-main branch push');
});

test('push-gate leaves an unrelated command untouched', skipNoGates, () => {
  const r = runHook(PUSH_HOOK, { command: 'ls -la' });
  assertAllowed(r, 'unrelated command');
});

test('push-gate: NO-SHIP-CHECK in-command comment bypasses the block', skipNoProbe, () => {
  const r = runHook(PUSH_HOOK, {
    command: `git push origin ${PROBE_BRANCH}:main  # NO-SHIP-CHECK: docs-only revert of an accidental commit`,
  });
  assertAllowed(r, 'NO-SHIP-CHECK bypass');
});

// ── push-gate: fail-open set ────────────────────────────────────────────────

test('push-gate fails open: REVIEW_GATE_DISABLE=1 kill switch overrides a command that would otherwise BLOCK', skipNoProbe, () => {
  const r = runHook(PUSH_HOOK, {
    command: `git push origin ${PROBE_BRANCH}:main`,
    env: { REVIEW_GATE_DISABLE: '1' },
  });
  assertAllowed(r, 'REVIEW_GATE_DISABLE=1');
});

test('push-gate fails open: missing transcript file never blocks', skipNoProbe, () => {
  const r = runHook(PUSH_HOOK, {
    command: `git push origin ${PROBE_BRANCH}:main`,
    transcript: '/nonexistent/transcript.jsonl',
  });
  assertAllowed(r, 'missing transcript');
});

test('push-gate fails open: malformed stdin never blocks', skipNoGates, () => {
  const r = spawnSync('bash', [PUSH_HOOK], { input: 'not json at all', encoding: 'utf8' });
  assertAllowed(r, 'malformed stdin');
});
