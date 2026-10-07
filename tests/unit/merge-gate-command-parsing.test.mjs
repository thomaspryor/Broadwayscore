// tests/unit/merge-gate-command-parsing.test.mjs — BRO-2436 regression: the
// merge gate's command parser (scripts/lib/review-gate.mjs's parseMergeIngress
// / queryMergeGate) must not fail OPEN on a command PREFIX.
//
// Reported bug: `timeout 900 bash scripts/merge-worktree-to-main.sh <branch>`
// parsed as "no merge ingress" (isMerge:false) and was therefore allowed
// unconditionally, while the byte-identical command WITHOUT the "timeout 900 "
// prefix was correctly gated. This let BRO-1699 land on shared main unreviewed.
//
// Every prefixed/compound form below must be recognised structurally
// (isMerge:true, via the same wrapper/git-merge classification as the bare
// form) OR — for a shape this shallow parser genuinely cannot structurally
// resolve — fail CLOSED (queryMergeGate returns allowed:false) rather than
// silently defaulting to allowed:true. "No merge ingress parsed" must never
// again mean "allowed" for a command that plainly contains one.
//
// Per CLAUDE.md rule 15, this imports the REAL functions — it does not restate
// their parsing logic.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseMergeIngress, queryMergeGate } from '../../scripts/lib/review-gate.mjs';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

// A scratch repo with an unreviewed gated-line branch, for the end-to-end
// queryMergeGate check — proves the parse actually blocks, not just labels.
function makeRepoWithUnreviewedBranch() {
  const repo = mkdtempSync(join(tmpdir(), 'merge-gate-parsing-test-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'base.js'), 'console.log(1);\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(repo, 'scripts', 'feature.js'),
    Array.from({ length: 40 }, (_, i) => `console.log(${i});`).join('\n') + '\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'feature: 40 lines, never reviewed');
  git(repo, 'checkout', '-q', 'main');
  return repo;
}

const WRAPPER_CMD = 'bash scripts/merge-worktree-to-main.sh worktree-feature';

const CASES = [
  { name: 'bare wrapper invocation', command: WRAPPER_CMD },
  { name: '"timeout N" prefix', command: `timeout 900 ${WRAPPER_CMD}` },
  { name: '"nohup" prefix', command: `nohup ${WRAPPER_CMD} &` },
  { name: '"env VAR=1" prefix', command: `env FOO=1 ${WRAPPER_CMD}` },
  { name: '"cd <dir> && <merge>" compound', command: `cd /tmp/some-worktree && ${WRAPPER_CMD}` },
  { name: 'plain `git merge` of a branch into main', command: 'git merge worktree-feature' },
];

for (const { name, command } of CASES) {
  test(`parse: ${name} yields isMerge:true or a fail-closed refusal`, () => {
    const ingress = parseMergeIngress(command, { currentBranch: 'main' });
    if (!ingress.isMerge) {
      assert.fail(
        `expected isMerge:true (or fail-closed refusal further downstream), got ` +
        `isMerge:false with reason "${ingress.reason}" — this is the BRO-2436 bypass: ` +
        `an unparsed command silently reads as "not a merge".`
      );
    }
    assert.equal(ingress.targetsMain, true, `command should target main: ${command}`);
  });

  test(`gate: ${name} is never silently allowed:true when unreviewed`, () => {
    const repo = makeRepoWithUnreviewedBranch();
    // `worktree-feature` doesn't exist as a real branch in this scratch repo —
    // only `feature` does — so swap the ingress source at the queryMergeGate
    // level by reusing the same command shape against the real branch name.
    const realCommand = command.replace('worktree-feature', 'feature');
    const result = queryMergeGate({ repoRoot: repo, command: realCommand, currentBranch: 'main' });
    assert.equal(result.allowed, false,
      `an unreviewed merge carried by "${realCommand}" must be blocked, got allowed:${result.allowed} ` +
      `(reason: ${result.reason})`);
  });
}

test('parse: an unrelated command (ls -la) is still allowed — the gate must not start blocking ordinary Bash calls', () => {
  const ingress = parseMergeIngress('ls -la', { currentBranch: 'main' });
  assert.equal(ingress.isMerge, false);
});

test('gate: an unrelated command (ls -la) is allowed end-to-end', () => {
  const repo = makeRepoWithUnreviewedBranch();
  const result = queryMergeGate({ repoRoot: repo, command: 'ls -la', currentBranch: 'main' });
  assert.equal(result.allowed, true);
});

test('parse: an unknown wrapper prefix around the merge wrapper still fails closed, not open (defense in depth)', () => {
  // `strace`/`sudo`/a future coreutil — anything NOT in the known-interpreter
  // list. This is the non-negotiable from the issue: an unrecognised SHAPE
  // must not read as "not a merge" just because this shallow parser doesn't
  // know the prefix by name.
  const ingress = parseMergeIngress(`sudo ${WRAPPER_CMD}`, { currentBranch: 'main' });
  assert.equal(ingress.isMerge, true);
  assert.equal(ingress.targetsMain, true);
  assert.equal(ingress.unparsedFailClosed, true);
});

test('parse: a quoted commit message merely naming "git merge" is not treated as a merge (no new false-positive)', () => {
  const ingress = parseMergeIngress('git commit -m "docs: explain how git merge works"', { currentBranch: 'main' });
  assert.equal(ingress.isMerge, false);
});

// ── Adversarial-review follow-ups (hand-traced by /ship-check, now pinned) ──

test('parse: stacked wrappers ("timeout N nohup <wrapper>") unwrap all the way through', () => {
  const ingress = parseMergeIngress(`timeout 900 nohup ${WRAPPER_CMD}`, { currentBranch: 'main' });
  assert.equal(ingress.isMerge, true);
  assert.equal(ingress.via, 'wrapper');
  assert.equal(ingress.targetsMain, true);
});

test('parse: "nice -n10 <wrapper>" (attached short-flag value, no space) still reaches the wrapper', () => {
  const ingress = parseMergeIngress(`nice -n10 ${WRAPPER_CMD}`, { currentBranch: 'main' });
  assert.equal(ingress.isMerge, true);
  assert.equal(ingress.via, 'wrapper');
});

test('parse: "stdbuf -oL <wrapper>" (attached short-flag value, no space) still reaches the wrapper', () => {
  const ingress = parseMergeIngress(`stdbuf -oL ${WRAPPER_CMD}`, { currentBranch: 'main' });
  assert.equal(ingress.isMerge, true);
  assert.equal(ingress.via, 'wrapper');
});

test('parse: "command -p git merge <branch>" (command builtin\'s own flag) still classifies as git-merge', () => {
  const ingress = parseMergeIngress('command -p git merge feature', { currentBranch: 'main' });
  assert.equal(ingress.isMerge, true);
  assert.equal(ingress.via, 'git-merge');
  assert.equal(ingress.targetsMain, true);
});

test('parse: real git subcommands that merely contain "merge" as a substring (merge-base) are not misread', () => {
  const ingress = parseMergeIngress('git merge-base main feature', { currentBranch: 'main' });
  assert.equal(ingress.isMerge, false);
});

test('parse: "sudo /usr/bin/git merge <branch>" (absolute-path git, not a bare "git" token) still fails closed', () => {
  // Codex adversarial review, BRO-2436: the catch-all's git-token check used
  // exact string equality, so an absolute-path git ('/usr/bin/git') never
  // matched 'git' and this real merge fell all the way through to
  // notMerge() — allowed:true, the exact bug class this ticket exists to
  // close. Fixed by matching on basename() like the wrapper check already did.
  const ingress = parseMergeIngress('sudo /usr/bin/git merge feature', { currentBranch: 'main' });
  assert.equal(ingress.isMerge, true);
  assert.equal(ingress.unparsedFailClosed, true);
});

test('parse: known documented trade-off — a quoted DATA argument that happens to equal the wrapper path also fails closed', () => {
  // printf's format-string argument here is DATA, not an invocation — but
  // tokenize() drops which tokens were quoted before this function ever sees
  // them, and a quoted COMMAND name is legal shell that must still be caught
  // (see the comment above looksLikeUnparsedMergeIngress's call site). This
  // pins the accepted cost so it reads as a documented decision, not an
  // overlooked regression, per the adversarial review that raised it.
  const ingress = parseMergeIngress("printf '%s\\n' 'scripts/merge-worktree-to-main.sh'", { currentBranch: 'main' });
  assert.equal(ingress.isMerge, true);
  assert.equal(ingress.unparsedFailClosed, true);
});

test('parse: known documented trade-off — an UNQUOTED echo of the literal words "git" then "merge" fails closed too', () => {
  // No real merge happens here — this is the deliberate, safe-direction cost
  // of the token-level catch-all: it cannot distinguish "these two words
  // appear in an echoed status line" from "this file is a wrapper this
  // parser doesn't recognise." Failing closed (recoverable via the hook's
  // NO-SHIP-CHECK/REVIEW_GATE_DISABLE escape hatches) is the intentional
  // trade-off per the issue's non-negotiable; a QUOTED echo argument (the
  // realistic case — see the commit-message test above) is unaffected,
  // because tokenize() keeps a quoted string as one token.
  const ingress = parseMergeIngress('echo git merge test', { currentBranch: 'main' });
  assert.equal(ingress.isMerge, true);
  assert.equal(ingress.unparsedFailClosed, true);
});
