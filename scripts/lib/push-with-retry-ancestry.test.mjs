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
