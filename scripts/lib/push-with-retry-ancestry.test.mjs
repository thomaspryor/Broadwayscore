/**
 * Regression test for BRO-3899 — push-with-retry.sh can drop a merged commit
 * from main's ancestry under concurrent push contention.
 *
 * Root cause: a plain `git rebase -X theirs origin/$PULL_BRANCH` (no
 * --rebase-merges) computes its replay range as "commits reachable from HEAD,
 * not in upstream, excluding merges" — so when a caller's own local HEAD is
 * itself a merge commit (e.g. `git merge worktree-branch --no-edit`, made
 * just before invoking this script, as in the BRO-3899 incident), the rebase
 * silently DROPS that merge commit from history. The commit object itself is
 * not destroyed (still reachable via `git log --all`), and file/tree CONTENT
 * usually still matches (the merge's diff gets replayed via its underlying
 * non-merge commits) — which is exactly why this script's own content-based
 * safety nets (verify_content_survived, check-post-rebase-survival.js) never
 * fire: they check file content, not whether the specific merge commit
 * object remains an ancestor of HEAD. The push can even report SUCCESS
 * (exit 0) while silently flattening the merge out of main's history.
 *
 * Reproduced directly (see this task's investigation): create a local merge
 * commit, have origin diverge on an unrelated file (so `git rebase -X
 * theirs origin/main` resolves with zero real conflicts), and confirm
 * `git merge-base --is-ancestor <merge-sha> HEAD` goes from true to false
 * after the rebase.
 *
 * Harness follows the established pattern in
 * tests/unit/push-with-retry-abort-preserves-head.test.mjs (real git, real
 * bare "origin" + a "seed" clone that plays the concurrent writer, a
 * "runner" clone that push-with-retry.sh actually runs in) rather than
 * mocking git — no wrapper is needed here since the goal is to exercise the
 * REAL rebase path, not to force a specific failure branch.
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
  // Same rationale as the sibling #466 fixture: force-unset regardless of
  // host so this file's own node --test run (itself spawned inside GitHub
  // Actions, where GITHUB_ACTIONS=true is ambient) doesn't leak into the
  // fixture's env via the ...process.env spread below.
  GITHUB_ACTIONS: '',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
}

test('BRO-3899: a pre-existing local merge commit survives a rebase-driven conflict resolution', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-retry-3899-'));
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

    // The caller's own pre-existing merge commit — mirrors the incident
    // shape exactly: a completed worktree/feature branch merged into main
    // BEFORE push-with-retry.sh is ever invoked. main must have its OWN
    // commit first so the merge is a genuine two-parent merge commit, not a
    // fast-forward (a fast-forward creates no merge commit at all — verified
    // empirically while building this fixture: `git rev-list --merges` finds
    // nothing and this test can't reproduce the bug without this step).
    sh('git checkout -q -b feature', runnerDir);
    fs.writeFileSync(path.join(runnerDir, 'feature.js'), 'const feature = 1;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "feature commit"', runnerDir);
    sh('git checkout -q main', runnerDir);
    fs.writeFileSync(path.join(runnerDir, 'main-own.js'), 'const mainOwn = 1;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "main own commit"', runnerDir);
    sh(`git merge --no-edit -q feature -m "Merge branch 'feature'"`, runnerDir);
    const mergeCommit = sh('git rev-parse HEAD', runnerDir).trim();
    const mergeParents = sh(`git log -1 --format=%P ${mergeCommit}`, runnerDir).trim().split(' ');
    assert.equal(mergeParents.length, 2, `sanity check: merge commit must have 2 parents, got ${mergeParents.length}`);
    assert.equal(
      sh(`git merge-base --is-ancestor ${mergeCommit} HEAD && echo yes || echo no`, runnerDir).trim(),
      'yes',
      'sanity check: merge commit must start out as its own ancestor',
    );

    // Concurrent writer advances origin on a DIFFERENT file — the push
    // below is rejected (non-fast-forward) and push-with-retry.sh's
    // fetch+rebase machinery engages with zero real textual conflicts, so
    // the rebase-clean path (not the conflict-resolution rounds) runs.
    fs.writeFileSync(path.join(seedDir, 'remote-change.js'), 'const remote = 1;\n');
    sh('git add -A', seedDir);
    sh('git commit -q -m "concurrent commit"', seedDir);
    sh(`git push -q "${originDir}" main`, seedDir);

    let stdout = '';
    let code = 0;
    try {
      stdout = execSync(`bash "${SCRIPT}" 3 main`, {
        cwd: runnerDir,
        stdio: 'pipe',
        env: { ...process.env, ...GIT_ENV, PUSH_FAILURE_LOG: path.join(tmp, 'failures.jsonl') },
      }).toString();
    } catch (err) {
      code = err.status ?? 1;
      stdout = `${err.stdout || ''}${err.stderr || ''}`;
    }

    const finalHead = sh('git rev-parse HEAD', runnerDir).trim();
    const finalLog = sh('git log --oneline', runnerDir).trim();

    // The push should succeed (the rebase resolves with zero real
    // conflicts) — this is the dangerous shape of the bug: no error is
    // ever printed, yet the merge commit's ancestry gets silently dropped.
    assert.equal(code, 0, `expected push to succeed cleanly; got ${code}. Output:\n${stdout}`);
    assert.match(finalLog, /feature commit/, `feature commit's content vanished entirely. Log:\n${finalLog}`);
    assert.equal(
      sh(`git merge-base --is-ancestor ${mergeCommit} ${finalHead} && echo yes || echo no`, runnerDir).trim(),
      'yes',
      `merge commit ${mergeCommit} was dropped from main's ancestry (BRO-3899) — HEAD is ${finalHead} but does not descend from it, even though its content survived. Output:\n${stdout}`,
    );

    // Also verify against what actually landed on origin, not just local —
    // the whole point is that main's ancestry (as pushed) must be intact.
    const originHasMerge = sh(
      `git --git-dir="${originDir}" merge-base --is-ancestor ${mergeCommit} main && echo yes || echo no`,
    ).trim();
    assert.equal(originHasMerge, 'yes',
      `origin/main does not descend from the merge commit ${mergeCommit} either — the drop was pushed. Output:\n${stdout}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// A `git` wrapper that fails EVERY `push` call (network sim, never reaches
// real git for push) so the local retry loop exhausts and falls through to
// the Git Data API fallback — but that fallback has no server to actually
// call (push-via-git-api.sh needs GH_TOKEN/a real GitHub API), so this
// exercises the fallback's own pre-flight disqualifier logic without
// needing real API credentials: the merge-commit disqualifier added for
// BRO-3899 fires BEFORE any network call, purely from the local git state.
// Subcommand detection skips `-c key=val` pairs, matching the sibling
// abort-preserves-head fixtures (git_push invokes `git -c ... push ...`).
function makeAllPushesFailGitDir(tmp) {
  const dir = path.join(tmp, 'fake-git-allpushfail-bin');
  fs.mkdirSync(dir);
  const realGit = execSync('command -v git').toString().trim();
  fs.writeFileSync(path.join(dir, 'git'), `#!/usr/bin/env bash
sub=""
args=("$@")
i=0
while [ $i -lt \${#args[@]} ]; do
  a="\${args[$i]}"
  case "$a" in
    -c|-C) i=$((i+2)); continue;;
    -*) i=$((i+1)); continue;;
    *) sub="$a"; break;;
  esac
done
if [ "$sub" = "push" ]; then
  exit 1
fi
exec "${realGit}" "$@"
`);
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return dir;
}

test('BRO-3899: the Git Data API fallback is disqualified (not silently squashed) when a merge commit is in range', () => {
  // push-via-git-api.sh squashes every outgoing commit into ONE API commit
  // by plumbing (its own header: "squashing N outgoing commits into one API
  // commit") — safe for ordinary multi-commit pushes, but it would silently
  // collapse a merge commit to single-parent, discarding the branch it
  // merged in. The fix adds a disqualifier so the fallback refuses to run
  // (and the local exhaustion path's restore_head_if_moved leaves HEAD at
  // the last known-good, merge-intact state) instead of squashing it away.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-retry-3899-api-'));
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

    sh('git checkout -q -b feature', runnerDir);
    fs.writeFileSync(path.join(runnerDir, 'feature.js'), 'const feature = 1;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "feature commit"', runnerDir);
    sh('git checkout -q main', runnerDir);
    fs.writeFileSync(path.join(runnerDir, 'main-own.js'), 'const mainOwn = 1;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "main own commit"', runnerDir);
    sh(`git merge --no-edit -q feature -m "Merge branch 'feature'"`, runnerDir);
    const mergeCommit = sh('git rev-parse HEAD', runnerDir).trim();
    const mergeParents = sh(`git log -1 --format=%P ${mergeCommit}`, runnerDir).trim().split(' ');
    assert.equal(mergeParents.length, 2, `sanity check: merge commit must have 2 parents, got ${mergeParents.length}`);

    const fakeGitDir = makeAllPushesFailGitDir(tmp);

    let stdout = '';
    let code = 0;
    try {
      stdout = execSync(`bash "${SCRIPT}" 2 main`, {
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

    const finalHead = sh('git rev-parse HEAD', runnerDir).trim();

    assert.notEqual(code, 0, `expected non-zero exit (every push fails, API fallback disqualified); got 0. Output:\n${stdout}`);
    assert.match(stdout, /skipping Git Data API fallback — our outgoing diff contains a merge commit/,
      `expected the new merge-commit API-fallback disqualifier to fire. Output:\n${stdout}`);
    assert.equal(
      sh(`git merge-base --is-ancestor ${mergeCommit} ${finalHead} && echo yes || echo no`, runnerDir).trim(),
      'yes',
      `merge commit ${mergeCommit} was dropped from local HEAD's ancestry after exhaustion (HEAD is ${finalHead}). Output:\n${stdout}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('BRO-3899: a merge in range does not trigger the early-fallback break (remaining local attempts are spent, not forfeited)', () => {
  // The post-loop fallback block disqualifies a merge commit, so breaking out
  // of the retry loop early "to try the fallback" would forfeit the remaining
  // local attempts for a fallback that cannot run (the BRO-3663 cliff, here
  // for merge commits). PUSH_API_FALLBACK_AFTER_ATTEMPTS=2 with 3 attempts
  // makes the old code break at attempt 2; the fixed code must reach attempt 3.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-retry-3899-early-'));
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

    sh('git checkout -q -b feature', runnerDir);
    fs.writeFileSync(path.join(runnerDir, 'feature.js'), 'const feature = 1;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "feature commit"', runnerDir);
    sh('git checkout -q main', runnerDir);
    fs.writeFileSync(path.join(runnerDir, 'main-own.js'), 'const mainOwn = 1;\n');
    sh('git add -A', runnerDir);
    sh('git commit -q -m "main own commit"', runnerDir);
    sh(`git merge --no-edit -q feature -m "Merge branch 'feature'"`, runnerDir);

    const fakeGitDir = makeAllPushesFailGitDir(tmp);

    let stdout = '';
    let code = 0;
    try {
      stdout = execSync(`bash "${SCRIPT}" 3 main`, {
        cwd: runnerDir,
        stdio: 'pipe',
        env: {
          ...process.env, ...GIT_ENV,
          PATH: `${fakeGitDir}:${process.env.PATH}`,
          PUSH_API_FALLBACK_AFTER_ATTEMPTS: '2',
          PUSH_FAILURE_LOG: path.join(tmp, 'failures.jsonl'),
        },
      }).toString();
    } catch (err) {
      code = err.status ?? 1;
      stdout = `${err.stdout || ''}${err.stderr || ''}`;
    }

    assert.notEqual(code, 0, `expected non-zero exit (every push fails); got 0. Output:\n${stdout}`);
    assert.match(stdout, /NOT breaking out early for the Git Data API fallback — our outgoing range contains a merge commit/,
      `expected the early-break gate to be suppressed by the merge commit. Output:\n${stdout}`);
    assert.doesNotMatch(stdout, /breaking out of the local fetch\+rebase\+push loop early/,
      `the loop broke out early and forfeited its remaining local attempts. Output:\n${stdout}`);
    assert.match(stdout, /Push failed \(attempt 3\/3\)/,
      `attempt 3 of 3 never ran — the remaining local attempts were forfeited. Output:\n${stdout}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
