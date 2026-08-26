#!/usr/bin/env node
// scripts/lib/memory-sync-pull.js — reconcile the shared main checkout with
// origin before a retry push, without ever leaving conflict residue behind.
//
// Repo policy: NEVER rebase main. `git pull --rebase` silently drops merge
// commits (2026-06-21 incident, memory/feedback_pull_rebase_drops_merge_commits.md)
// and scripts/merge-worktree-to-main.sh already encodes "integrate origin
// with git merge, NEVER rebase" for exactly that reason. sync-memory-to-repo.sh
// was the one remaining call still doing `pull --rebase --autostash` against
// the checkout every session shares — and because it ran with `|| true` and
// stderr suppressed, a conflicting replay left `.git/rebase-merge` residue
// with HEAD detached and reported nothing. scripts/lib/push-with-retry.sh's
// BRO-142 guard then refuses to touch that checkout again until a human
// clears it, wedging every other session's push (task #1893).
//
// syncMemoryPull() fetches + merges (never rebases) and aborts on any
// failure before returning, so residue-free is the property this buys —
// not merely "prefer merge over rebase".

'use strict';

/**
 * @param {object} a
 * @param {string} a.repo  absolute path to the checkout
 * @param {(args: string[]) => {status: number, stdout: string, stderr: string}} a.git
 *   injected git runner — the CLI entrypoint below passes one backed by
 *   child_process.spawnSync; tests pass a fake that can simulate a
 *   conflicting merge without touching disk.
 * @param {(line: string) => void} [a.logError] defaults to console.error
 * @returns {{result: 'ok'|'aborted'|'skipped', abortIssued: boolean, detail: string}}
 */
function syncMemoryPull({ repo, git, logError = (line) => console.error(line) }) {
  if (!repo || typeof git !== 'function') {
    throw new Error('syncMemoryPull requires { repo, git }');
  }

  const fetch = git(['-C', repo, 'fetch', '-q', 'origin', 'main']);
  if (fetch.status !== 0) {
    logError(`memory-sync-pull: fetch failed — ${fetch.stderr.trim()}`);
    return { result: 'skipped', abortIssued: false, detail: 'fetch failed' };
  }

  const merge = git(['-C', repo, 'merge', '--no-edit', '-q', 'origin/main']);
  if (merge.status === 0) {
    return { result: 'ok', abortIssued: false, detail: 'merged cleanly' };
  }

  logError(`memory-sync-pull: merge with origin/main failed, aborting — ${merge.stderr.trim()}`);
  const abortMerge = git(['-C', repo, 'merge', '--abort']);
  let abortIssued = true;
  if (abortMerge.status !== 0) {
    // Nothing to merge-abort (e.g. a stray rebase already in progress from
    // some other path) — fall back so no residue is left either way.
    const abortRebase = git(['-C', repo, 'rebase', '--abort']);
    if (abortRebase.status !== 0) {
      logError(`memory-sync-pull: abort failed — merge:${abortMerge.stderr.trim()} rebase:${abortRebase.stderr.trim()}`);
      abortIssued = false;
    }
  }

  return { result: 'aborted', abortIssued, detail: merge.stderr.trim() };
}

module.exports = { syncMemoryPull };

if (require.main === module) {
  const { spawnSync } = require('child_process');
  const repoArgIdx = process.argv.indexOf('--repo');
  const repo = repoArgIdx !== -1 ? process.argv[repoArgIdx + 1] : process.cwd();
  const git = (args) => {
    const r = spawnSync('git', args, { encoding: 'utf8' });
    return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const outcome = syncMemoryPull({ repo, git });
  console.error(`memory-sync-pull: ${outcome.result} — ${outcome.detail}`);
  process.exit(outcome.result === 'ok' ? 0 : 1);
}
