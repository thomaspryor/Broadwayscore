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
