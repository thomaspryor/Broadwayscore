#!/usr/bin/env node
/**
 * record-push-retry-failure.js — durably records one push-with-retry.sh
 * failure so it survives the ephemeral CI runner (task: push-retry-failure
 * telemetry, 2026-08-23, Notion 3c5637c5-416f-81c3-8bbb-d574d991a841, Phase 0
 * of the push-contention systemic fix — /plan-review'd, six independent
 * reviewers).
 *
 * Why this exists: scripts/lib/push-with-retry.sh's record_push_failure()
 * has, until now, only appended to a GITIGNORED local file
 * (data/audit/push-retry-failures.jsonl). "When the failed push is the ONLY
 * write in a CI job, this local file dies with the runner before it can be
 * committed" (push-with-retry.sh's own comment) — so scripts/health-check.js's
 * "Push-retry deadman" digest row has been reporting "Cannot measure" for
 * months, and the 104 prior patches to the push-retry subsystem all shipped
 * with no way to tell if any of them worked.
 *
 * STORAGE: mirrors scripts/record-push-ledger.js's proven pattern exactly —
 * entries live on a SEPARATE dedicated single-commit branch
 * (`push-retry-failures`, not `push-ledger`: that branch's tree holds a
 * single blob per scripts/lib/push-ledger-store.js's design, and this is a
 * genuinely different, unrelated data stream) via the now-generalized
 * scripts/lib/push-ledger-store.js.
 *
 * CALLING CONTRACT (this is what makes it safe to call from inside
 * push-with-retry.sh's retry loop, not just at final exhaustion — plan-review
 * finding: record_push_failure() fires at MULTIPLE points inside the retry
 * loop under real contention, not only once at the end. A synchronous,
 * awaited call here would inject blocking latency into the exact loop this
 * telemetry exists to observe, worsening the contention it measures):
 *   - The caller (push-with-retry.sh) MUST invoke this in the BACKGROUND
 *     (`node ... &`, disowned) and MUST NOT wait on it. This script does not
 *     assume that — it is safe to run synchronously too — but it is written
 *     assuming its own wall-clock is invisible to the caller.
 *   - Bounded to 8 CAS attempts with FULL-JITTER backoff (0..min(cap,
 *     base*2^i)ms), roughly double record-push-ledger.js's 4-attempt/linear
 *     budget. Deliberately more aggressive than the success-ledger's
 *     recorder: push successes are naturally staggered (this repo's own
 *     measured 31s median inter-commit gap), but FAILURES are correlated —
 *     a real contention burst means many of ~153 workflows hit this
 *     recorder within the same narrow window, all racing the same CAS
 *     lease. A concurrent-writer stress test (tests/unit/push-retry-
 *     failure-ledger.test.mjs) simulating 10 simultaneous writers caught a
 *     dropped entry at the original 4-attempt/linear-backoff budget before
 *     this was tuned up — full jitter (not linear) matters more than raw
 *     attempt count for de-correlating simultaneous retriers.
 *   - Always exits 0 — fail-open, best-effort telemetry, never the payload.
 *
 * Usage: node scripts/record-push-retry-failure.js --reason=X --attempt=N
 *   --max-retries=N --branch=main --remote=origin-repo-slug
 *   [--workflow=...] [--ci=true]
 * Kill switch: PUSH_SKIP_FAILURE_LEDGER=1 — deliberately SEPARATE from
 * record-push-ledger.js's PUSH_SKIP_LEDGER, so debugging/disabling one
 * telemetry stream can't silently blind the other (plan-review finding).
 */
'use strict';

const { execFileSync } = require('child_process');
const { buildFailureEntry } = require('./lib/push-ledger');
const { readLedger, writeLedger } = require('./lib/push-ledger-store');
const { hasHelpFlag } = require('./lib/cli-help');

const MAX_ATTEMPTS = 8;
const FAILURE_BRANCH = 'push-retry-failures';
const FAILURE_FILE = 'failures.jsonl';
// Same canonical-repo gate as record-push-ledger.js, same reason: several
// workflows run push-with-retry.sh from inside private data-repo clones
// (cd data/review-texts; bash ../../scripts/lib/push-with-retry.sh), and
// recording there would create never-pruned branches nothing monitors.
const CANONICAL_ORIGIN_RE = /[:/]Broadwayscore(\.git)?$/i;

// Data-repo clones embed a live GitHub token in the remote URL — strip the
// userinfo segment before any origin URL reaches a log (task #1742).
function redactRemoteUrl(url) {
  if (!url) return url;
  return url.replace(/\/\/[^@/]+@/, '//');
}

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

// Full jitter (AWS-style): U(0, min(cap, base*2^attempt)) — a wide random
// window de-correlates simultaneously-retrying writers far better than
// linear backoff (1000*attempt), which keeps every writer's retry schedule
// in near-lockstep and does little to break ties under a synchronized burst
// (the exact failure the concurrent-writer stress test below caught before
// this was tuned).
function jitterMs(attempt, base = 200, cap = 4000) {
  return Math.floor(Math.random() * Math.min(cap, base * 2 ** attempt));
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/record-push-retry-failure.js --reason=X --attempt=N --max-retries=N --branch=main --remote=slug [--workflow=...] [--ci=true]');
    process.exit(0);
  }

  if (process.env.PUSH_SKIP_FAILURE_LEDGER === '1') {
    process.exit(0);
  }

  const args = parseArgs(process.argv.slice(2));
  const reason = args.reason;
  if (!reason) {
    console.error('record-push-retry-failure: --reason is required — skipping (fail open)');
    process.exit(0);
  }

  const entryLine = buildFailureEntry({
    reason,
    attempt: Number(args.attempt) || 0,
    maxRetries: Number(args['max-retries']) || 0,
    branch: args.branch || 'main',
    remote: args.remote || '',
    workflow: args.workflow || process.env.GITHUB_WORKFLOW || '',
    ci: args.ci === 'true' || Boolean(process.env.GITHUB_ACTIONS),
    ts: new Date().toISOString(),
  });

  const cwd = process.cwd();
  if (process.env.PUSH_LEDGER_ANY_ORIGIN !== '1' && !CANONICAL_ORIGIN_RE.test(originUrl(cwd))) {
    console.log(`record-push-retry-failure: skipping — cwd origin (${redactRemoteUrl(originUrl(cwd)) || 'none'}) is not the canonical Broadwayscore repo`);
    process.exit(0);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { tip, content } = readLedger(cwd, { branch: FAILURE_BRANCH, file: FAILURE_FILE });
      let base = content;
      if (base && !base.endsWith('\n')) base += '\n';
      writeLedger(cwd, base + entryLine + '\n', tip, { branch: FAILURE_BRANCH, file: FAILURE_FILE });
      console.log(`record-push-retry-failure: recorded "${reason}" on the ${FAILURE_BRANCH} branch`);
      process.exit(0);
    } catch (err) {
      console.error(`record-push-retry-failure: attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await sleep(jitterMs(attempt));
    }
  }

  console.error('record-push-retry-failure: giving up after retries (non-blocking — best-effort telemetry only)');
  process.exit(0); // always fail open
}

if (require.main === module) {
  main().catch(err => {
    console.error(`record-push-retry-failure: fatal: ${err.message}`);
    process.exit(0); // fail open
  });
}

module.exports = { redactRemoteUrl, FAILURE_BRANCH, FAILURE_FILE };
