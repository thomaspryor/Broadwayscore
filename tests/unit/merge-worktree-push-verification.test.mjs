/**
 * BRO-253: merge-worktree-to-main.sh printed "→ pushed" and exited 0 on
 * 2026-08-11 while origin never actually advanced (verified after the fact:
 * `git merge-base --is-ancestor <sha> origin/main` was 1), and a second,
 * back-to-back failure left another live session's stash conflicted in the
 * shared checkout.
 *
 * Both scenarios are exercised against the REAL script
 * (scripts/merge-worktree-to-main.sh) in disposable fixture repos — never a
 * re-implementation of its bash logic (CLAUDE.md §15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const MERGE_SCRIPT = path.join(repoRoot, 'scripts', 'merge-worktree-to-main.sh');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  // The real script shells out to node helpers (landing-verify.js,
  // push-content-survival.js, run-push-audits.sh, merge-post-merge-test-gate.js)
  // that assume this repo's scripts/lib/ layout — point it at the real one so
  // those helpers resolve, while git operations stay confined to the fixture.
};

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// Sets up: bare origin + a working repo on main with a no-op push-audits
// stub (the fixture has no real scripts/lib/, so the script's own
// push-audit/test-floor helpers must no-op cleanly) + a feature branch.
function setupRepo(dir) {
  const originDir = path.join(dir, 'origin.git');
  const repoDir = path.join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--bare', originDir], { env: GIT_ENV });
  execFileSync('git', ['init', '-q', repoDir], { env: GIT_ENV });
  git(repoDir, ['config', 'user.email', 't@t']);
  git(repoDir, ['config', 'user.name', 't']);
  git(repoDir, ['branch', '-M', 'main']);

  writeFile(path.join(repoDir, 'scripts', 'lib', 'run-push-audits.sh'), '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n');
  fs.chmodSync(path.join(repoDir, 'scripts', 'lib', 'run-push-audits.sh'), 0o755);
  writeFile(path.join(repoDir, 'base.txt'), 'base\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'base']);
  git(repoDir, ['remote', 'add', 'origin', originDir]);
  git(repoDir, ['push', '-q', 'origin', 'main']);

  git(repoDir, ['checkout', '-q', '-b', 'feature-branch']);
  writeFile(path.join(repoDir, 'feature.txt'), 'feature\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'feature commit']);
  git(repoDir, ['push', '-q', 'origin', 'feature-branch']);
  git(repoDir, ['checkout', '-q', 'main']);

  return { originDir, repoDir };
}

// A `git` shim that proxies every subcommand to the real git EXCEPT `push`
// targeting origin — that one prints a plausible-looking success line and
// exits 0 WITHOUT touching the bare origin, exactly the class of silent
// non-landing push (task #959/#833/BRO-253) the script's ancestor check
// exists to catch.
function installPhantomPushGitShim(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  // merge-worktree-to-main.sh invokes every git call as `git -C <dir> <sub> …`
  // (its g() helper) — the subcommand is not necessarily $1, so scan past a
  // leading -C <dir> before checking for "push".
  const shim = `#!/usr/bin/env bash
args=("$@")
i=0
if [ "\${args[0]:-}" = "-C" ]; then i=2; fi
if [ "\${args[$i]:-}" = "push" ]; then
  echo "To origin"
  echo "   0000000..1111111  main -> main"
  exit 0
fi
exec "${realGit}" "$@"
`;
  const shimPath = path.join(binDir, 'git');
  fs.writeFileSync(shimPath, shim);
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

function runMergeScript(cwd, args, envOverrides = {}) {
  return spawnSync('bash', [MERGE_SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...GIT_ENV, ...envOverrides },
    timeout: 60_000,
  });
}

test('merge-worktree-to-main.sh does NOT report "pushed" when the push never actually lands on origin', () => {
  const dir = mkTmpDir('bro253-phantom-');
  try {
    const { originDir, repoDir } = setupRepo(dir);
    const binDir = path.join(dir, 'fakebin');
    installPhantomPushGitShim(binDir);

    const preOriginHead = git(originDir, ['rev-parse', 'main']);

    const result = runMergeScript(repoDir, ['feature-branch'], {
      PATH: `${binDir}:${process.env.PATH}`,
    });

    const postOriginHead = git(originDir, ['rev-parse', 'main']);

    // Ground truth: origin genuinely did not advance.
    assert.equal(postOriginHead, preOriginHead, 'test setup invariant: the phantom-push shim must leave origin untouched');

    // The script must never claim success when origin didn't move.
    assert.notEqual(result.status, 0, `script exited 0 despite origin never advancing. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.doesNotMatch(
      result.stdout,
      /^→ pushed$/m,
      `script printed a bare "pushed" success line without the push having landed. stdout:\n${result.stdout}`
    );
    assert.doesNotMatch(
      result.stdout,
      /integrated into main and verified/,
      `script printed its final success banner despite origin never advancing. stdout:\n${result.stdout}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('merge-worktree-to-main.sh: a conflicted stash from a prior failed run is surfaced, not silently discarded or silently left to block the next session', () => {
  const dir = mkTmpDir('bro253-stash-');
  try {
    const { repoDir } = setupRepo(dir);

    // Simulate the BRO-253 shape: another LIVE session has real uncommitted
    // WIP sitting in a tracked file the incoming branch does NOT touch, and
    // origin/main independently advances that same file (the concurrent-push
    // race this repo runs under). The script stashes the WIP as "daemon
    // churn," merges cleanly, and then `git stash pop` conflicts against the
    // origin-side content it just merged in — a conflict `git stash pop`
    // itself creates without ever setting MERGE_HEAD (verified: a stash-pop
    // conflict is not a `git merge` and never sets that marker), so any
    // "only protect real content when MERGE_HEAD is present" check cannot
    // see it.
    writeFile(path.join(repoDir, 'shared-script.js'), 'base content\n');
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-q', '-m', 'add shared-script.js']);
    git(repoDir, ['push', '-q', 'origin', 'main']);

    // Origin-side change to the same file (another session's push landing
    // between this run's fetch and its stash-pop).
    const originAdvanceClone = path.join(dir, 'origin-advance-clone');
    execFileSync('git', ['clone', '-q', path.join(dir, 'origin.git'), originAdvanceClone], { env: GIT_ENV });
    git(originAdvanceClone, ['config', 'user.email', 't@t']);
    git(originAdvanceClone, ['config', 'user.name', 't']);
    writeFile(path.join(originAdvanceClone, 'shared-script.js'), 'origin advanced this line\n');
    git(originAdvanceClone, ['add', '-A']);
    git(originAdvanceClone, ['commit', '-q', '-m', 'origin advances shared-script.js']);
    git(originAdvanceClone, ['push', '-q', 'origin', 'main']);

    // Real, uncommitted WIP from "another live session" sitting dirty in the
    // shared checkout when this run starts.
    writeFile(path.join(repoDir, 'shared-script.js'), 'ANOTHER SESSION REAL WIP — do not discard\n');

    const result = runMergeScript(repoDir, ['feature-branch']);

    const fileContent = fs.readFileSync(path.join(repoDir, 'shared-script.js'), 'utf8');
    const stashList = git(repoDir, ['stash', 'list']);

    const silentlyDiscarded = !fileContent.includes('ANOTHER SESSION REAL WIP') && stashList === '';
    assert.ok(
      !silentlyDiscarded,
      `the other session's real WIP was silently discarded (reset --hard + stash drop) with no trace left for recovery. ` +
        `script exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nfinal file:\n${fileContent}`
    );

    // Whatever the resolution, it must be LOUD: a script that silently
    // exits 0 while leaving the working tree either conflicted or
    // discarded-without-comment is the exact "left silently blocking the
    // next session" failure BRO-253 reports.
    if (result.status === 0) {
      assert.match(
        result.stdout + result.stderr,
        /stash|conflict/i,
        `script exited 0 after touching another session's stash without mentioning it anywhere in its output. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
