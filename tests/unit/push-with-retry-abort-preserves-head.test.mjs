/**
 * Regression test for task #543 — push-with-retry.sh's #466 shallow-ancestry-
 * unrecoverable abort must be a true no-op on local refs. A 2026-07-26 incident
 * saw local `main` lose two committed-but-unpushed commits after a run that
 * ended in exactly this abort; the mutation was never pinned down, so
 * push-with-retry.sh now captures HEAD once at script entry and force-restores
 * it before every abort if it drifted (restore_head_if_moved()). This test
 * reproduces the #466 condition — a shallow local clone whose boundary commit
 * is provably NOT an ancestor of the remote tip, even after widening — and
 * asserts local HEAD is byte-identical before and after the script's abort.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(fileURLToPath(new URL('../../scripts/lib/push-with-retry.sh', import.meta.url)));

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
}

// A `git` wrapper that forces `git rebase ... -X ...` and `git merge ... -X
// ...` to fail while passing every other invocation (fetch, push, reset,
// cherry-pick, rev-parse, rebase --abort/--continue, merge --abort, ...)
// straight to the real git. This deterministically drives push-with-retry.sh
// into its "last resort: reset + cherry-pick" fallback without needing to
// construct a git conflict that survives the script's own auto-resolution
// (resolve_conflicts() handles almost every real conflict shape, including
// modify/delete and binary — the fallback is otherwise very hard to reach
// with a realistic fixture).
function makeFakeGitDir(tmp) {
  const dir = path.join(tmp, 'fake-git-bin');
  fs.mkdirSync(dir);
  const realGit = execSync('command -v git').toString().trim();
  fs.writeFileSync(path.join(dir, 'git'), `#!/usr/bin/env bash
case "$1" in
  rebase|merge)
    for a in "$@"; do if [ "$a" = "-X" ]; then exit 1; fi; done
    ;;
esac
exec "${realGit}" "$@"
`);
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return dir;
}

test('#466 shallow-ancestry-unrecoverable abort leaves local HEAD byte-identical', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-retry-head-'));
  const originDir = path.join(tmp, 'origin.git');
  const seedDir = path.join(tmp, 'seed');
  const runnerDir = path.join(tmp, 'runner');

  try {
    sh(`git init -q --bare "${originDir}"`, tmp);
    sh(`git init -q "${seedDir}"`, tmp);
    sh('git config user.email t@t.t', seedDir);
    sh('git config user.name t', seedDir);
    sh('git commit -q --allow-empty -m base', seedDir);
    sh('git branch -M main', seedDir);
    sh(`git push -q "${originDir}" main`, seedDir);

    // Shallow runner clone anchored at the current tip — that commit becomes
    // the shallow boundary that must remain an ancestor of the fetched tip.
    fs.mkdirSync(runnerDir);
    sh('git init -q', runnerDir);
    sh('git config user.email t@t.t', runnerDir);
    sh('git config user.name t', runnerDir);
    sh(`git remote add origin "${originDir}"`, runnerDir);
    sh('git fetch -q --depth=1 origin main', runnerDir);
    sh('git checkout -q -B main FETCH_HEAD', runnerDir);
    assert.equal(sh('git rev-parse --is-shallow-repository', runnerDir).trim(), 'true');

    // The two local, committed-but-unpushed commits (mirrors the incident:
    // task #543's evidence names scripts/lib/cmux-launch.js specifically).
    fs.writeFileSync(path.join(runnerDir, 'cmux-launch.js'), 'const survivingWs = 1;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "add survivingWs"', runnerDir);
    fs.writeFileSync(path.join(runnerDir, 'other.js'), 'const x = 2;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "second commit"', runnerDir);
    const preRunHead = sh('git rev-parse HEAD', runnerDir).trim();
    const preRunLog = sh('git log --oneline', runnerDir).trim();

    // Rewrite origin's history to a totally unrelated orphan root. The
    // runner's shallow boundary commit is now unreachable from origin/main
    // under ANY depth or --shallow-since window — this is what guarantees the
    // #466 ancestry-escalation abort fires (not a transient too-shallow case
    // the widen step would otherwise fix).
    sh('git checkout -q --orphan rewritten', seedDir);
    fs.writeFileSync(path.join(seedDir, 'rewritten.txt'), 'unrelated history\n');
    sh('git add -A', seedDir);
    sh('git commit -q -m "unrelated root"', seedDir);
    sh(`git push -q -f "${originDir}" rewritten:main`, seedDir);

    let stdout = '';
    let code = 0;
    try {
      stdout = execSync(`bash "${SCRIPT}" 1 main`, {
        cwd: runnerDir,
        stdio: 'pipe',
        env: { ...process.env, ...GIT_ENV, PUSH_FAILURE_LOG: path.join(tmp, 'failures.jsonl') },
      }).toString();
    } catch (err) {
      code = err.status ?? 1;
      stdout = `${err.stdout || ''}${err.stderr || ''}`;
    }

    const postRunHead = sh('git rev-parse HEAD', runnerDir).trim();
    const postRunLog = sh('git log --oneline', runnerDir).trim();

    assert.notEqual(code, 0, `expected non-zero exit; got 0. Output:\n${stdout}`);
    assert.match(stdout, /depth-bounded fetch could not restore ancestry/, `expected the #466 abort path to fire. Output:\n${stdout}`);
    assert.equal(postRunHead, preRunHead, `HEAD moved from ${preRunHead} to ${postRunHead} during the abort — local commits at risk`);
    assert.equal(postRunLog, preRunLog, 'local commit log changed during the abort');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an uncontrolled set -e crash right after a successful rebase still restores HEAD via the EXIT trap', () => {
  // Adversarial-review finding (task #543): the manual restore_head_if_moved()
  // calls only guard explicit `exit 1` sites. A crash under `set -e` from an
  // UNGUARDED command — e.g. restore_protected_fields()'s `count=$(node ...)`,
  // which runs immediately after a successful rebase has already moved HEAD —
  // would previously skip every guard and die with HEAD stranded mid-flight.
  // This reproduces exactly that shape using a stubbed restore-protected-
  // fields.js that always exits 1, and asserts the script-wide EXIT trap
  // still restores HEAD to its pre-run value.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-retry-trap-'));
  const originDir = path.join(tmp, 'origin.git');
  const seedDir = path.join(tmp, 'seed');
  const runnerDir = path.join(tmp, 'runner');
  const fixtureLibDir = path.join(tmp, 'fixture-scripts', 'lib');
  const fixtureScriptsDir = path.join(tmp, 'fixture-scripts');

  try {
    sh(`git init -q --bare "${originDir}"`, tmp);
    sh(`git init -q "${seedDir}"`, tmp);
    sh('git config user.email t@t.t', seedDir);
    sh('git config user.name t', seedDir);
    sh('git commit -q --allow-empty -m base', seedDir);
    sh('git branch -M main', seedDir);
    sh(`git push -q "${originDir}" main`, seedDir);

    // Full (non-shallow) clone — the #466 ancestry machinery must stay out of
    // the way so the plain `git rebase -X theirs` clean-success path runs.
    fs.mkdirSync(runnerDir);
    sh('git init -q', runnerDir);
    sh('git config user.email t@t.t', runnerDir);
    sh('git config user.name t', runnerDir);
    sh(`git remote add origin "${originDir}"`, runnerDir);
    sh('git fetch -q origin main', runnerDir);
    sh('git checkout -q -B main origin/main', runnerDir);

    fs.writeFileSync(path.join(runnerDir, 'local-change.js'), 'const local = 1;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "local commit"', runnerDir);
    const preRunHead = sh('git rev-parse HEAD', runnerDir).trim();

    // A concurrent, non-conflicting commit on a DIFFERENT file — guarantees
    // `git rebase -X theirs origin/main` succeeds cleanly (no conflict
    // resolution round needed), landing squarely on the restore_protected_
    // fields() call that follows a clean rebase.
    fs.writeFileSync(path.join(seedDir, 'remote-change.js'), 'const remote = 1;\n');
    sh('git add -A', seedDir);
    sh('git commit -q -m "concurrent commit"', seedDir);
    sh(`git push -q "${originDir}" main`, seedDir);

    // Isolated copy of push-with-retry.sh + its sibling deps so we can stub
    // JUST restore-protected-fields.js without touching the real script.
    fs.mkdirSync(fixtureLibDir, { recursive: true });
    const realLibDir = path.dirname(SCRIPT);
    const realScriptsDir = path.dirname(realLibDir);
    for (const f of fs.readdirSync(realLibDir)) {
      if (f.endsWith('.js') || f === 'push-with-retry.sh') {
        fs.copyFileSync(path.join(realLibDir, f), path.join(fixtureLibDir, f));
      }
    }
    for (const f of ['check-orphan-commits.js', 'check-post-rebase-survival.js', 'validate-added-review-ownership.js']) {
      const src = path.join(realScriptsDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(fixtureScriptsDir, f));
    }
    fs.writeFileSync(path.join(fixtureLibDir, 'restore-protected-fields.js'), '#!/usr/bin/env node\nprocess.exit(1);\n');
    const fixtureScript = path.join(fixtureLibDir, 'push-with-retry.sh');

    let stdout = '';
    let code = 0;
    try {
      stdout = execSync(`bash "${fixtureScript}" 1 main`, {
        cwd: runnerDir,
        stdio: 'pipe',
        env: { ...process.env, ...GIT_ENV, PUSH_FAILURE_LOG: path.join(tmp, 'failures.jsonl') },
      }).toString();
    } catch (err) {
      code = err.status ?? 1;
      stdout = `${err.stdout || ''}${err.stderr || ''}`;
    }

    const postRunHead = sh('git rev-parse HEAD', runnerDir).trim();

    assert.notEqual(code, 0, `expected non-zero exit (stubbed restore-protected-fields.js always fails); got 0. Output:\n${stdout}`);
    assert.equal(postRunHead, preRunHead, `HEAD moved from ${preRunHead} to ${postRunHead} and was NOT restored — the EXIT trap backstop did not fire. Output:\n${stdout}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reset+cherry-pick fallback replays ALL outgoing commits, not just the tip', () => {
  // The actual root cause (confirmed by a parallel investigation on the
  // Notion card, 2026-07-26): when rebase and merge both fail and the script
  // falls back to "reset --hard origin/$PULL_BRANCH; cherry-pick $OUR_HEAD",
  // `git cherry-pick <sha>` replays only THAT ONE commit's diff. If 2+ local
  // commits were outgoing, `reset --hard` throws away the whole branch and
  // cherry-pick puts back only the last one — the earlier commit(s) vanish
  // with no error anywhere (the push of the resulting state SUCCEEDS). This
  // is the exact "two local commits" symptom from the incident. Forces the
  // script down this exact fallback via a git wrapper (see makeFakeGitDir)
  // rather than fighting to construct a conflict the script's own
  // resolve_conflicts() can't already auto-resolve.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-retry-cherrypick-'));
  const originDir = path.join(tmp, 'origin.git');
  const seedDir = path.join(tmp, 'seed');
  const runnerDir = path.join(tmp, 'runner');

  try {
    sh(`git init -q --bare "${originDir}"`, tmp);
    sh(`git init -q "${seedDir}"`, tmp);
    sh('git config user.email t@t.t', seedDir);
    sh('git config user.name t', seedDir);
    sh('git commit -q --allow-empty -m base', seedDir);
    sh('git branch -M main', seedDir);
    sh(`git push -q "${originDir}" main`, seedDir);

    fs.mkdirSync(runnerDir);
    sh('git init -q', runnerDir);
    sh('git config user.email t@t.t', runnerDir);
    sh('git config user.name t', runnerDir);
    sh(`git remote add origin "${originDir}"`, runnerDir);
    sh('git fetch -q origin main', runnerDir);
    sh('git checkout -q -B main origin/main', runnerDir);

    // Two outgoing commits touching DIFFERENT files — the crux of the bug.
    fs.writeFileSync(path.join(runnerDir, 'first-commit-file.js'), 'const a = 1;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "first commit"', runnerDir);
    fs.writeFileSync(path.join(runnerDir, 'second-commit-file.js'), 'const b = 2;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "second commit"', runnerDir);

    // A concurrent, unrelated commit on the remote so the push is rejected
    // and the retry loop's fetch+rebase/merge/fallback machinery engages.
    fs.writeFileSync(path.join(seedDir, 'remote-change.js'), 'const remote = 1;\n');
    sh('git add -A', seedDir);
    sh('git commit -q -m "concurrent commit"', seedDir);
    sh(`git push -q "${originDir}" main`, seedDir);

    const fakeGitDir = makeFakeGitDir(tmp);

    let stdout = '';
    let code = 0;
    try {
      stdout = execSync(`bash "${SCRIPT}" 1 main`, {
        cwd: runnerDir,
        stdio: 'pipe',
        env: {
          ...process.env, ...GIT_ENV,
          PATH: `${fakeGitDir}:${process.env.PATH}`,
          PUSH_FAILURE_LOG: path.join(tmp, 'failures.jsonl'),
        },
      }).toString();
    } catch (err) {
      code = err.status ?? 1;
      stdout = `${err.stdout || ''}${err.stderr || ''}`;
    }

    assert.match(stdout, /reset \+ cherry-pick approach/, `expected the reset+cherry-pick fallback to engage. Output:\n${stdout}`);
    assert.equal(code, 0, `expected the fallback to succeed and push cleanly; got ${code}. Output:\n${stdout}`);
    assert.equal(fs.existsSync(path.join(runnerDir, 'first-commit-file.js')), true,
      `first commit's file is MISSING after the fallback — the single-commit cherry-pick bug reproduced. Output:\n${stdout}`);
    assert.equal(fs.existsSync(path.join(runnerDir, 'second-commit-file.js')), true,
      `second commit's file is missing after the fallback. Output:\n${stdout}`);

    const originLog = sh(`git --git-dir="${originDir}" log --oneline main`).trim();
    assert.match(originLog, /first commit/, `origin/main is missing "first commit" — it was pushed without the earlier local commit. Log:\n${originLog}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
