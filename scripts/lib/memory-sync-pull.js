#!/usr/bin/env node
'use strict';
/**
 * memory-sync-pull.js — safe pull for sync-memory-to-repo.sh's commit+push
 * step against the SHARED ~/Broadwayscore checkout (task #1893).
 *
 * The old inline call did `git pull --rebase --autostash origin main`. That
 * violates the repo's own policy (merge-worktree-to-main.sh: "integrate
 * origin with `git merge` (NEVER rebase)" — `git pull --rebase` silently
 * drops merge commits, 2026-06-21 incident) AND, when the rebase replay
 * conflicted, left `.git/rebase-merge` residue with HEAD detached —
 * swallowed by `|| true` + `-q` + `2>/dev/null`, so the failure was
 * completely invisible. That residue then wedged push-with-retry.sh's
 * BRO-142 guard for every OTHER session sharing the checkout (confirmed
 * twice in one night, 2026-08-26 — see Notion task #1893).
 *
 * syncMainSafely() replaces the rebase with `fetch` + `merge --no-edit`
 * (matches the documented merge-worktree-to-main.sh policy), and on ANY
 * merge failure runs `merge --abort` before returning so a conflicting
 * replay can never leave residue behind. It also refuses to touch the
 * checkout at all if an in-progress operation marker (MERGE_HEAD,
 * REBASE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD) already exists before this
 * run started — that residue belongs to someone else's operation, not
 * ours to abort (same BRO-142 principle push-with-retry.sh applies).
 *
 * This module's own marker check and abort are a narrower backstop for
 * direct/standalone invocation (`node memory-sync-pull.js <repo>`). The
 * AUTHORITATIVE guard is in sync-memory-to-repo.sh's caller: it holds
 * scripts/lib/push-mutex.sh's fleet-wide lock (the SAME lock
 * push-with-retry.sh / merge-worktree-to-main.sh hold) for the whole
 * fetch+merge window, and checks scripts/lib/detect-stale-merge-head.sh's
 * markers immediately after acquiring it (the BRO-142 ordering — checking
 * before the mutex is held leaves a TOCTOU window where another session's
 * operation can start between the check and the merge). Without that
 * mutex, this module's own git calls could still interleave with a
 * concurrent session's in-flight rebase/merge on the same shared checkout.
 *
 * `git` is injectable so the decision logic is tested without a real repo
 * (CLAUDE.md rule 15 — colocated scripts/lib/memory-sync-pull.test.mjs
 * require()s this module, no copied logic).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

/** @type {(args: string[], cwd: string) => {code:number, stdout:string, stderr:string}} */
function realGit(args, cwd) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(err.message || ''),
    };
  }
}

// Same marker set push-with-retry.sh's BRO-142 guard checks (task #1558).
const OPERATION_MARKERS = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

function resolveGitPath(git, cwd, name) {
  const result = git(['rev-parse', '--path-format=absolute', '--git-path', name], cwd);
  return result.code === 0 ? result.stdout.trim() : '';
}

// REBASE_HEAD is a real ref only while a rebase step is STOPPED on a content
// conflict — confirmed empirically (task #1893 ship-check finding): a rebase
// stopped by a non-conflict failure (e.g. mid `--exec`) has NO REBASE_HEAD,
// even though `.git/rebase-merge/` (interactive backend) or
// `.git/rebase-apply/` (apply-based backend) persists on disk for the whole
// operation. Checking REBASE_HEAD alone would silently miss that case and
// proceed to fetch/merge on top of a live rebase. Same technique as
// detect-stale-merge-head.sh's `_rebase_staleness_path`. `pathExists` is
// injectable so this stays testable without touching a real filesystem.
function findExistingOperation(git, cwd, pathExists = fs.existsSync) {
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (git(['rev-parse', '-q', '--verify', marker], cwd).code === 0) return marker;
  }
  if (git(['rev-parse', '-q', '--verify', 'REBASE_HEAD'], cwd).code === 0) return 'REBASE_HEAD';
  const rebaseMerge = resolveGitPath(git, cwd, 'rebase-merge');
  if (rebaseMerge && pathExists(rebaseMerge)) return 'REBASE_HEAD';
  const rebaseApply = resolveGitPath(git, cwd, 'rebase-apply');
  if (rebaseApply && pathExists(rebaseApply)) return 'REBASE_HEAD';
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.cwd - repo working directory
 * @param {typeof realGit} [opts.git]
 * @param {string} [opts.remote]
 * @param {string} [opts.branch]
 * @param {(path: string) => boolean} [opts.pathExists]
 * @param {(msg: string) => void} [opts.log] - stderr sink; never swallowed
 * @returns {{status: 'ok'|'fetch-failed'|'aborted'|'blocked-existing-residue',
 *            stderr: string, marker?: string, abortIssued?: boolean, abortOk?: boolean}}
 */
function syncMainSafely({
  cwd,
  git = realGit,
  remote = 'origin',
  branch = 'main',
  pathExists = fs.existsSync,
  log = (msg) => process.stderr.write(msg + '\n'),
}) {
  const existing = findExistingOperation(git, cwd, pathExists);
  if (existing) {
    log(
      `memory-sync-pull: refusing to touch checkout — ${existing} already present before this run started (a pre-existing in-progress git operation, not ours to abort).`
    );
    return { status: 'blocked-existing-residue', marker: existing, stderr: '' };
  }

  const fetch = git(['fetch', remote, branch], cwd);
  if (fetch.code !== 0) {
    log(`memory-sync-pull: fetch ${remote}/${branch} failed: ${fetch.stderr.trim()}`);
    return { status: 'fetch-failed', stderr: fetch.stderr };
  }

  // Merge FETCH_HEAD (exactly what the fetch above just wrote), not
  // `${remote}/${branch}` — the remote-tracking ref only updates on a
  // standard refspec. FETCH_HEAD is written by every `git fetch` regardless
  // of refspec config, so this can't silently merge a stale tracking ref
  // (the class of bug push-with-retry.sh works around with an explicit
  // destination refspec + update-ref).
  const merge = git(['merge', '--no-edit', 'FETCH_HEAD'], cwd);
  if (merge.code === 0) {
    return { status: 'ok', stderr: '' };
  }

  log(
    `memory-sync-pull: merge ${remote}/${branch} failed, aborting to avoid leaving residue on the shared checkout: ${merge.stderr.trim()}`
  );
  const abort = git(['merge', '--abort'], cwd);
  if (abort.code !== 0) {
    log(
      `memory-sync-pull: 'git merge --abort' itself failed — checkout may still have MERGE_HEAD residue and needs manual cleanup: ${abort.stderr.trim()}`
    );
  }
  return { status: 'aborted', stderr: merge.stderr, abortIssued: true, abortOk: abort.code === 0 };
}

module.exports = { syncMainSafely, realGit, findExistingOperation, OPERATION_MARKERS };

if (require.main === module) {
  const cwd = process.argv[2] || process.cwd();
  const result = syncMainSafely({ cwd });
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.status === 'ok' ? 0 : 1);
}
