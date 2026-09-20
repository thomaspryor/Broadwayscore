#!/usr/bin/env node
/**
 * route-main-streak-signatures.js — BRO-3865: file/resolve per-breakage
 * alert-router conditions for main's test.yml, keyed by WHICH job/step/test
 * is failing rather than just "main is red".
 *
 * Before this, test.yml's push-triggered dispatch filed every red push under
 * ONE conditionKey ('test-yml:main-streak'). While main stayed red for ANY
 * reason, routeAlert's cooldown/dedup collapsed every NEW, unrelated
 * breakage into that same stale condition — main was red 2026-08-12 through
 * 2026-09-20 (63 notifications, one card) while at least four independent
 * failures came and went under it, none getting its own card.
 *
 * Invoked from test.yml's test-summary job on every push to main (success or
 * failure, never on cancelled runs — see the workflow step's `if:`).
 * Resolution always runs; dispatch/escalation only when the caller passes
 * the matching flag (it already gated should_dispatch/should_escalate on the
 * consecutive-failure streak before invoking this script).
 *
 * gh CLI, not the REST API via fetch: same choice as produce-trunk-
 * snapshot.js — `gh run view --json jobs` / `--log-failed` are the cheap way
 * to get job/step + TAP failure text for the run this script executes in,
 * and gh already carries the runner's GITHUB_TOKEN auth.
 *
 *   node scripts/route-main-streak-signatures.js --run-id=$GITHUB_RUN_ID --dispatch --streak=2
 */
'use strict';

const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  failingStepSignatures, firstFailingTestNamesByScope, signaturesToResolve, RED_SIGNATURE_PREFIX,
} = require('./lib/main-red-streak.js');
const { routeAlert, loadLedger, resolveCondition } = require('./lib/owner-alert-router.js');

const USAGE = `route-main-streak-signatures.js — BRO-3865 per-breakage alert routing for main's test.yml
  node scripts/route-main-streak-signatures.js --run-id=<id> [--dispatch] [--escalate] [--prev-url=<url>] [--streak=<n>]
    --run-id     required — the workflow run to inspect (gh run view --json jobs / --log-failed)
    --dispatch   file an 'auto' card for each currently-failing signature (caller gates this on streak>=2)
    --escalate   also send/resurface the 'test-yml:main-streak-escalation' human page (caller gates this on streak>=4)
    --prev-url   previous failed run's URL, folded into the escalation email's fields
    --streak     consecutive-failure count, folded into alert fields/description
  Resolution (closing signatures whose step went green on THIS run) always runs, independent of the flags above.
  --help, -h   print this usage and exit — no reads/writes
`;

function gh(args, { maxBuffer = 32 * 1024 * 1024, timeout = 120000 } = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer, timeout });
}

function parseArgs(argv) {
  const out = { dispatch: false, escalate: false, runId: null, prevUrl: '', streak: '?', excludeJob: null };
  for (const arg of argv) {
    if (arg === '--dispatch') out.dispatch = true;
    else if (arg === '--escalate') out.escalate = true;
    else if (arg.startsWith('--run-id=')) out.runId = arg.slice('--run-id='.length);
    else if (arg.startsWith('--prev-url=')) out.prevUrl = arg.slice('--prev-url='.length);
    else if (arg.startsWith('--streak=')) out.streak = arg.slice('--streak='.length);
    else if (arg.startsWith('--exclude-job=')) out.excludeJob = arg.slice('--exclude-job='.length);
  }
  return out;
}

function fetchCurrentRunJobs(runId) {
  const jobsJson = JSON.parse(gh(['run', 'view', String(runId), '--json', 'jobs']));
  return jobsJson.jobs || [];
}

// Best-effort: `--log-failed` can be slow on a huge log, and a run with no
// failing steps has nothing to fetch. Never let this block resolution —
// callers fall back to job+step-only signatures (no test name) on failure.
function fetchFailedLogText(runId) {
  try {
    return gh(['run', 'view', String(runId), '--log-failed']);
  } catch (err) {
    console.error(`[route-main-streak-signatures] --log-failed fetch failed (${err.message}); signatures fall back to job+step only.`);
    return '';
  }
}

function runUrlFor(runId) {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY) return '';
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${runId}`;
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.runId) { console.error('[route-main-streak-signatures] --run-id is required'); process.exitCode = 1; return; }

  // The job THIS script runs inside (test-summary / "Test Summary") is
  // excluded: its own "Check results" step fails whenever ANY sibling job
  // fails (that's its entire job — `contains(needs.*.result, 'failure')`),
  // so including it would manufacture a signature that names the aggregator,
  // not a root cause, on every single red push. Matched by display NAME
  // (`--exclude-job`, passed literally from test.yml) because `gh run view
  // --json jobs` exposes no YAML-job-id equivalent to `github.job` to match
  // on instead — second-opinion-reviewed (BRO-3865) and accepted as the only
  // option this API offers, with this loud check as the mitigation: if the
  // name we were told to exclude doesn't match ANY job in this run, a rename
  // silently broke the exclusion and every push would start filing a
  // spurious "Test Summary" card — fail loudly instead of guessing.
  const allJobsFetched = fetchCurrentRunJobs(opts.runId);
  if (opts.excludeJob && !allJobsFetched.some((j) => j?.name === opts.excludeJob)) {
    console.error(`::warning::[route-main-streak-signatures] --exclude-job="${opts.excludeJob}" matched no job on this run (jobs seen: ${allJobsFetched.map((j) => j?.name).join(', ')}) — the aggregator job may have been renamed; update the --exclude-job value in test.yml or every red push will file a spurious signature for it.`);
  }
  const jobs = allJobsFetched.filter((j) => j?.name !== opts.excludeJob);
  const anyJobFailed = jobs.some((j) => j?.conclusion && !['success', 'skipped'].includes(j.conclusion));
  const testNames = anyJobFailed
    ? firstFailingTestNamesByScope(fetchFailedLogText(opts.runId))
    : { byScope: new Map(), byJob: new Map() };
  const currentSignatures = failingStepSignatures({ jobs }, testNames);

  // Resolve first, independent of --dispatch: a signature that went green
  // must close even on a run where the streak dropped below the dispatch
  // threshold and --dispatch was never passed — the ledger must not hold a
  // stale open condition just because nothing new was filed this run.
  const ledger = loadLedger();
  const openRedKeys = Object.entries(ledger.conditions || {})
    .filter(([, c]) => c && c.status === 'open')
    .map(([key]) => key)
    .filter((key) => key.startsWith(RED_SIGNATURE_PREFIX));
  const toResolve = signaturesToResolve(openRedKeys, currentSignatures);
  for (const key of toResolve) {
    resolveCondition(key);
    console.log(`[route-main-streak-signatures] resolved ${key} — its step is green on this run`);
  }

  if (!opts.dispatch) return;

  const runUrl = runUrlFor(opts.runId);
  for (const sig of currentSignatures) {
    const label = sig.testName ? `${sig.job} / ${sig.step} — "${sig.testName}"` : `${sig.job} / ${sig.step}`;
    await routeAlert({
      conditionKey: sig.conditionKey,
      title: `main test.yml red: ${label}`,
      description: `main's Test Suite is failing on ${label} (${opts.streak} consecutive push${opts.streak === '1' ? '' : 'es'} red). Direct pushes to main are not gated by required checks, so broken code is landing on the production branch. This card is scoped to THIS specific breakage — a different job/step/test failing at the same time gets its own card instead of deduping into this one.`,
      severity: 'error',
      disposition: 'auto',
      cardAction: 'Fix',
      fields: [
        { name: 'Job', value: sig.job },
        { name: 'Step', value: sig.step },
        { name: 'First failing test', value: sig.testName || 'n/a (non-test step, or no TAP line found)' },
        { name: 'This failed run', value: runUrl ? `[View logs](${runUrl})` : 'n/a' },
      ],
      url: runUrl || undefined,
    }).catch((e) => console.error(`[route-main-streak-signatures] dispatch failed for ${sig.conditionKey}: ${e.message}`));
  }

  if (opts.escalate) {
    const failingJobsLabel = currentSignatures.length
      ? [...new Set(currentSignatures.map((s) => s.job))].join(', ')
      : 'unknown (job-set lookup unavailable)';
    await routeAlert({
      conditionKey: 'test-yml:main-streak-escalation',
      title: 'main test.yml STILL red — auto-dispatch did not resolve it',
      description: `main test.yml is STILL red after ${opts.streak} consecutive pushes — the auto-dispatch card(s) filed at the 2nd failure have not resolved it. Currently failing: ${failingJobsLabel}. Direct pushes to main are not gated by required checks, so broken code is landing on the production branch. Investigate and fix now.`,
      severity: 'error',
      disposition: 'human',
      model: 'opus',
      fields: [
        { name: 'This failed run', value: runUrl ? `[View logs](${runUrl})` : 'n/a' },
        { name: 'Previous failed run', value: opts.prevUrl ? `[View logs](${opts.prevUrl})` : 'n/a' },
        { name: 'Consecutive failures', value: opts.streak },
        { name: 'Currently failing job(s)', value: failingJobsLabel },
      ],
      url: runUrl || undefined,
      cooldownHours: 24,
    }).catch((e) => console.error(`[route-main-streak-signatures] escalation dispatch failed: ${e.message}`));
  }
}

main().catch((err) => {
  console.error(`[route-main-streak-signatures] fatal: ${err.message}`);
  process.exitCode = 1;
});
