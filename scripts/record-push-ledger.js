#!/usr/bin/env node
/**
 * record-push-ledger.js — appends one entry to the push ledger after a
 * push-with-retry.sh success (task #677).
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
 * STORAGE (2026-08-02 commit-churn rewrite, Notion 3b0637c5): entries live
 * on the dedicated single-commit `push-ledger` branch via
 * scripts/lib/push-ledger-store.js — NOT as commits to the payload branch.
 * The original design committed data/audit/recent-pushes.jsonl to main
 * itself, which at ~130 CI callers produced 861-1,239 bookkeeping commits
 * per day (~41% of all main commits) and materially worsened the push
 * contention this ledger exists to police. The store also never touches
 * HEAD/index/working tree, so the old unwindAttempt()/--mixed-resync
 * machinery (and its #687 phantom-staged-revert hazard) is gone entirely.
 *
 * Called from push-with-retry.sh ONLY after `pushed=true` — i.e. the
 * caller's actual payload already landed on origin. This script is
 * best-effort, fail-open telemetry:
 *   - Never blocks or fails the calling script (always exits 0).
 *   - Bounded to 4 CAS attempts. Worst case on a DEGRADED remote is ~2.5
 *     min (4 × (15s fetch + 25s push timeouts) + backoff), so the caller
 *     additionally wraps the invocation in a 60s hard timeout
 *     (push-with-retry.sh's _timeout) — normal-case runtime is 1-3s.
 *   - Operates on process.cwd()'s `origin` remote — the repo the caller
 *     just pushed — so test fixtures with a local bare origin never leak
 *     entries to the production remote (the pre-rewrite version anchored to
 *     REPO_ROOT and did exactly that from the push-with-retry unit tests).
 *   - CANONICAL-REPO GATE (ship-check adversarial finding): several
 *     workflows run push-with-retry.sh from INSIDE the private data-repo
 *     clones (cd data/review-texts; bash ../../scripts/lib/push-with-retry.sh).
 *     Recording there would create never-pruned, ever-growing push-ledger
 *     branches on the private repos that check-push-ledger.yml (main-repo
 *     only) would never see. So recording is skipped unless cwd's origin is
 *     the canonical Broadwayscore repo. Tests opt out of the gate with
 *     PUSH_LEDGER_ANY_ORIGIN=1 to exercise the real path against fixtures.
 *   - Rotation/pruning of old entries is the scheduled checker's job
 *     (scripts/check-push-ledger.js), not this hot path's.
 *
 * Usage: node scripts/record-push-ledger.js --sha=<sha> --branch=main [--fallback-used=true|false]
 * Kill switch: PUSH_SKIP_LEDGER=1 (mirrors PUSH_SKIP_CONTENT_SURVIVAL_CHECK
 * in push-with-retry.sh).
 */
'use strict';

const { execFileSync } = require('child_process');
const { buildLedgerEntry } = require('./lib/push-ledger');
const { readLedger, writeLedger } = require('./lib/push-ledger-store');
const { hasHelpFlag } = require('./lib/cli-help');

const MAX_ATTEMPTS = 4;
// Only the canonical public repo gets ledgered — see the header's
// CANONICAL-REPO GATE note. Matches https/ssh forms of the origin URL.
const CANONICAL_ORIGIN_RE = /[:/]Broadwayscore(\.git)?$/i;

function originUrl(cwd) {
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'],
      { cwd, encoding: 'utf8', timeout: 10000 }).trim();
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/record-push-ledger.js --sha=<sha> --branch=main');
    process.exit(0);
  }

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
    fallbackUsed: args['fallback-used'] === 'true',
  });

  const cwd = process.cwd();
  if (process.env.PUSH_LEDGER_ANY_ORIGIN !== '1' && !CANONICAL_ORIGIN_RE.test(originUrl(cwd))) {
    console.log(`record-push-ledger: skipping — cwd origin (${originUrl(cwd) || 'none'}) is not the canonical Broadwayscore repo (data-repo/fixture pushes are not ledgered; the checker only monitors the main repo)`);
    process.exit(0);
  }
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { tip, content } = readLedger(cwd);
      let base = content;
      if (base && !base.endsWith('\n')) base += '\n';
      writeLedger(cwd, base + entryLine + '\n', tip);
      console.log(`record-push-ledger: recorded ${sha} for ${branch} on the push-ledger branch`);
      process.exit(0);
    } catch (err) {
      console.error(`record-push-ledger: attempt ${attempt} failed: ${err.message}`);
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
