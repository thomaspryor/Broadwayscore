#!/usr/bin/env node
/**
 * record-push-ledger.js — appends one entry to data/audit/recent-pushes.jsonl
 * after a push-with-retry.sh success (task #677).
 *
 * Why this exists: task #619's content-survival check in push-with-retry.sh
 * only verifies AT PUSH TIME, inside the same CI job. The #668 incident class
 * (a push verified, then silently reverted minutes later by a concurrent
 * operation) is unmitigated for CI-side pushes because a GitHub Actions
 * runner terminates the instant the job ends — it cannot spawn a background
 * re-checker the way merge-worktree-to-main.sh's local-session mitigation
 * does (scripts/verify-merge-landed.js). The durable, out-of-process fix is
 * a ledger: record every successful push here, then a scheduled workflow
 * (check-push-ledger.yml -> scripts/check-push-ledger.js) re-checks recent
 * entries against origin on a delay long enough for a revert to have
 * already happened.
 *
 * Called from push-with-retry.sh ONLY after `pushed=true` — i.e. the
 * caller's actual payload already landed on origin. This script's own git
 * operations are a SEPARATE, best-effort, fail-open commit+push:
 *   - Never blocks or fails the calling script (always exits 0).
 *   - Bounded to 4 cheap attempts (~10-15s total for a single-line-JSONL
 *     commit — nowhere near push-with-retry.sh's own 7-retry budget for
 *     full conflict resolution) so it can't meaningfully extend any of
 *     push-with-retry.sh's ~130 CI callers' runtime, while still giving
 *     the ledger commit enough shots to land under the same high push
 *     contention that made push-with-retry.sh itself need 7 retries
 *     instead of 2-3 (ship-check adversarial-review finding).
 *   - Each attempt derives the ledger file fresh from `origin/<branch>`
 *     (not from local working-tree state), so a failed prior attempt never
 *     leaves stale content behind to trip up a retry — the ONLY thing this
 *     script ever writes to disk is LEDGER_REL_PATH, and on any failure it
 *     unstages+un-commits (never touches uncommitted files elsewhere in the
 *     working tree — no `git add -A`, no `reset --hard`, since this job may
 *     have other pending work still to commit later in the same run).
 *   - Rotation/pruning of old entries is the scheduled checker's job
 *     (scripts/check-push-ledger.js), not this hot path's.
 *
 * Usage: node scripts/record-push-ledger.js --sha=<sha> --branch=main
 * Kill switch: PUSH_SKIP_LEDGER=1 (mirrors PUSH_SKIP_CONTENT_SURVIVAL_CHECK
 * in push-with-retry.sh).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildLedgerEntry } = require('./lib/push-ledger');

const REPO_ROOT = path.join(__dirname, '..');
const LEDGER_REL_PATH = 'data/audit/recent-pushes.jsonl';
const LEDGER_ABS_PATH = path.join(REPO_ROOT, LEDGER_REL_PATH);
const MAX_ATTEMPTS = 4;

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function git(args, opts) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 20000, ...opts });
}

function safeRevParse() {
  try {
    return git(['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Undo whatever this attempt did to LEDGER_REL_PATH — and ONLY that path —
// so the next attempt (or the caller, if this was the last attempt) starts
// from a clean slate without disturbing any other pending work in the
// working tree. Restores the WORKING TREE content too (not just the index):
// leaving the failed attempt's written-but-uncommitted bytes on disk would
// let them leak into a later, unrelated commit in the same CI job if
// anything downstream stages broadly (ship-check finding).
function unwindAttempt(preAttemptHead) {
  const postAttemptHead = safeRevParse();
  if (preAttemptHead && postAttemptHead && postAttemptHead !== preAttemptHead) {
    try { git(['reset', '--soft', preAttemptHead]); } catch { /* best effort */ }
  }
  try { git(['reset', '--quiet', 'HEAD', '--', LEDGER_REL_PATH]); } catch { /* path may never have been staged */ }
  try {
    git(['checkout', '--quiet', 'HEAD', '--', LEDGER_REL_PATH]);
  } catch {
    // Not in HEAD yet (first-ever ledger entry) — our write is untracked; remove it.
    try { fs.unlinkSync(LEDGER_ABS_PATH); } catch { /* already gone / never written */ }
  }
}

// `git commit` always parents onto current local HEAD, not origin's tip —
// if a concurrent push advanced origin/<branch> since this job's checkout,
// committing without first catching HEAD up would make our push a
// guaranteed non-fast-forward reject on EVERY attempt, not just the first.
//
// MUST be `--mixed`, not `--soft` (ship-check P0 finding, reproduced live):
// `--soft` moves HEAD/the branch ref but leaves the INDEX frozen at
// whatever tree it had before the reset (this job's own just-pushed
// payload). If origin has moved past that point — routine, given ~130
// callers all invoking this on every successful push — the index now
// silently disagrees with the NEW HEAD for every file any concurrent push
// touched, and git reports that disagreement as a STAGED change even
// though nothing was ever `git add`ed. `git commit` commits the whole
// index, so those phantom staged "reversions" ride along with our
// intentional ledger `git add` and get pushed — silently reverting
// concurrent commits' real content back to our stale tree. This is the
// exact push-core-data stale-copy-back class (#51/#52) this repo has been
// bitten by before, self-inflicted by the mitigation meant to catch its
// cousin (#619/#668). `--mixed` resets the index to match the new HEAD
// (leaving the working tree untouched), so an untouched file's index entry
// correctly matches origin and can never be swept into our commit.
function fastForwardHeadToOrigin(branch) {
  git(['reset', '--mixed', `origin/${branch}`]);
}

async function main() {
  if (process.env.PUSH_SKIP_LEDGER === '1') {
    process.exit(0);
  }

  const args = parseArgs(process.argv.slice(2));
  const sha = args.sha;
  const branch = args.branch || 'main';
  if (!sha) {
    console.error('record-push-ledger: --sha is required — skipping (fail open)');
    process.exit(0);
  }

  const entryLine = buildLedgerEntry({
    sha,
    branch,
    ts: new Date().toISOString(),
    workflow: process.env.GITHUB_WORKFLOW || '',
    runId: process.env.GITHUB_RUN_ID || '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || '',
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const preAttemptHead = safeRevParse();
    try {
      git(['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeout: 15000 });
      fastForwardHeadToOrigin(branch);

      let baseContent = '';
      try {
        baseContent = git(['show', `origin/${branch}:${LEDGER_REL_PATH}`]);
      } catch {
        // File doesn't exist on origin yet (first-ever ledger entry) — start fresh.
      }
      if (baseContent && !baseContent.endsWith('\n')) baseContent += '\n';

      fs.mkdirSync(path.dirname(LEDGER_ABS_PATH), { recursive: true });
      fs.writeFileSync(LEDGER_ABS_PATH, baseContent + entryLine + '\n');
      git(['add', LEDGER_REL_PATH]);

      git(['commit', '-m', `chore: record push ledger entry (${sha.slice(0, 12)}) [skip ci]`, '--no-verify', '--quiet']);
      git(['push', 'origin', `HEAD:${branch}`], { timeout: 25000 });
      console.log(`record-push-ledger: recorded ${sha} on ${branch}`);
      process.exit(0);
    } catch (err) {
      console.error(`record-push-ledger: attempt ${attempt} failed: ${err.message}`);
      unwindAttempt(preAttemptHead);
      if (attempt < MAX_ATTEMPTS) await sleep(1000 * attempt);
    }
  }

  console.error('record-push-ledger: giving up after retries (non-blocking — the actual push already succeeded)');
  process.exit(0); // always fail open — this is best-effort telemetry, not the payload push
}

main().catch(err => {
  console.error(`record-push-ledger: fatal: ${err.message}`);
  process.exit(0); // fail open
});
