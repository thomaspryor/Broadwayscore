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
 * CALLING CONTRACT (revised after ship-check adversarial review found the
 * first version of this contract self-contradictory — it claimed "caller
 * MUST run this in the background" while push-with-retry.sh actually calls
 * it SYNCHRONOUSLY under a hard timeout; a future editor trusting this
 * comment over the real caller would have reintroduced the background+
 * disown approach that was deliberately rejected — see push-with-retry.sh's
 * record_push_failure() for why: a GitHub Actions step's process group can
 * be reaped moments after the step's own script exits, so a truly
 * backgrounded child has no completion guarantee on an ephemeral runner):
 *   - The caller (push-with-retry.sh) invokes this SYNCHRONOUSLY, wrapped in
 *     its own `_timeout 15` (15s hard cap), gated to fire at most ONCE per
 *     push-with-retry.sh invocation regardless of how many times
 *     record_push_failure() itself is called inside the retry loop. This
 *     script's own retry budget below is tuned to fit INSIDE that 15s
 *     ceiling with margin, not independently of it — the two numbers must
 *     be read together; changing one without the other reopens the
 *     mismatch ship-check caught.
 *   - Bounded to 6 CAS attempts with FULL-JITTER backoff (0..min(1800,
 *     150*2^i)ms) — worst-case cumulative sleep ≈150+300+600+1200+1800 ≈
 *     4050ms across 5 backoff gaps, leaving ~10s of the 15s ceiling for the
 *     attempts' actual git-plumbing time (each attempt is normal-case
 *     sub-second; the 15/25s per-git-call timeouts in push-ledger-store.js
 *     are outage floors, not the expected case). FAILURES are correlated
 *     (unlike push-ledger's naturally-staggered successes) — a real
 *     contention burst means many of ~153 workflows hit this recorder
 *     within the same narrow window, all racing the same CAS lease. A
 *     concurrent-writer stress test (tests/unit/push-retry-failure-
 *     ledger.test.mjs) simulating 10 simultaneous writers caught a dropped
 *     entry at the ORIGINAL 4-attempt/linear-backoff budget; full jitter
 *     (not linear) is what de-correlates simultaneous retriers, not raw
 *     attempt count — re-verified passing at these tighter 6-attempt/1800ms
 *     numbers before shipping.
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
const { buildFailureEntry, isGithubActionsRunner } = require('./lib/push-ledger');
const { readLedger, writeLedger } = require('./lib/push-ledger-store');
const { hasHelpFlag } = require('./lib/cli-help');

const MAX_ATTEMPTS = 6;
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
// this was tuned). base/cap sized to fit MAX_ATTEMPTS' cumulative worst-case
// sleep inside push-with-retry.sh's 15s outer `_timeout` — see this file's
// header CALLING CONTRACT for the arithmetic; the two numbers are read
// together, not independently.
function jitterMs(attempt, base = 150, cap = 1800) {
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
    // Canonical detection is isGithubActionsRunner() (task #1901, tested by
    // scripts/lib/push-retry-ci-detection.test.mjs); args.ci is an OR-fallback
    // for the --ci=true/false the bash caller already computed identically
    // (push-with-retry.sh:217), not a second independent source of truth.
    ci: isGithubActionsRunner(process.env) || args.ci === 'true',
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
