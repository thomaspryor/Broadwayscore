#!/usr/bin/env node
/**
 * Diagnose a workflow that check-cron-health.yml has flagged
 * "cron-health-chronic:<name>" (no successful run in 3+ consecutive daily
 * checks, after the one-shot self-heal redispatch already failed to fix it).
 *
 * check-cron-health.yml's staleness clock only advances on a `success`
 * conclusion. A chronically-stale cron is therefore NOT failing loudly —
 * `if: failure()` (notify-failure) never fires on a `cancelled` run, and
 * `severity: warning` is a no-op for anything but `critical` (see
 * .github/workflows/CLAUDE.md "Notification Severity") — so the actual
 * defect can sit unnoticed for weeks. This script pulls the real run/job
 * history and classifies each failing/cancelled job into the two shapes
 * that produce this exact silence (BRO-2285):
 *
 *   - timeout-cancelled: the job's wall-clock duration is close to (or over)
 *     its `timeout-minutes`, and its conclusion is `cancelled`, not
 *     `failure`. GitHub Actions reports a `timeout-minutes` kill this way —
 *     see memory/feedback_cron_timeout_needs_script_budget.md.
 *   - push-contention: the job `failure`d on a step named "Commit ..." /
 *     "Push ..." — the local fetch+rebase+push loop in
 *     scripts/lib/push-with-retry.sh lost its race against a busy main
 *     branch, and the Git Data API fallback was disqualified (see
 *     scripts/lib/core-data-merge-registry.js's apiFallbackSafe entries).
 *
 * Usage:
 *   node scripts/cron-health-chronic-orchestrator.js --workflow=commercial-weekly.yml [--limit=30]
 *
 * Requires: `gh` CLI authenticated against this repo (same as every other
 * gh-based script here). Read-only — makes no writes, triggers no runs.
 */

'use strict';

const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { classifyJob, readJobTimeouts } = require('./lib/cron-health.js');

const USAGE = `cron-health-chronic-orchestrator.js — Diagnose a chronically-stale cron workflow.

Usage:
  node scripts/cron-health-chronic-orchestrator.js --workflow=<file.yml> [--limit=N]
  node scripts/cron-health-chronic-orchestrator.js --help, -h    print this usage and exit

Options:
  --workflow=FILE   Workflow filename under .github/workflows/ (required)
  --limit=N         How many recent runs to inspect (default 15)
`;

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');
      flags[key] = val === undefined ? true : val;
    }
  }
  return flags;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }

  const flags = parseArgs(process.argv.slice(2));
  const workflowFile = flags.workflow;
  if (!workflowFile) {
    console.error('Usage: node scripts/cron-health-chronic-orchestrator.js --workflow=<file.yml> [--limit=N]');
    process.exit(1);
  }
  const limit = parseInt(flags.limit, 10) || 15;

  let timeouts = {};
  try {
    timeouts = readJobTimeouts(workflowFile);
  } catch (err) {
    console.warn(`⚠️  Could not read timeout-minutes from ${workflowFile}: ${err.message}`);
  }

  console.log(`\n🔎 Diagnosing ${workflowFile} (last ${limit} runs)\n`);

  // BRO-2530 what-else: `gh run list --limit=N` is the exact pattern
  // scripts/lib/gh-runs-query.sh's header comment (BRO-2771/BRO-2767) warns
  // never to use for run history on this repo — with 6,600+ test.yml runs on
  // main it has returned arbitrary, sometimes months-stale result SETS (three
  // identical invocations a minute apart returning three different date
  // ranges). This diagnostic tool exists specifically to answer "what's this
  // cron's real recent run history" for a human debugging a chronic-stale
  // alert, so trusting that exact discouraged call here would risk the tool
  // giving a confidently wrong answer. Query the REST endpoint directly
  // instead (same per_page cap and field-mapping approach as gh-runs-query.sh,
  // plus `event` since this tool prints it).
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
  if (limit > 100) {
    console.error(`--limit must be 1-100 (REST per_page cap), got ${limit}`);
    process.exit(1);
  }
  const runsRaw = gh([
    'api', `repos/${repo}/actions/workflows/${workflowFile}/runs?per_page=${limit}`,
    '--jq', '[.workflow_runs[] | {databaseId: .id, conclusion: .conclusion, createdAt: .created_at, event: .event}]',
  ]);
  const runs = JSON.parse(runsRaw)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  if (runs.length === 0) {
    console.log('No runs found for this workflow.');
    return;
  }

  const lastSuccess = runs.find((r) => r.conclusion === 'success');
  console.log(lastSuccess
    ? `Last SUCCESSFUL run: ${lastSuccess.createdAt} (${lastSuccess.event}) — https://github.com/${repo}/actions/runs/${lastSuccess.databaseId}`
    : `⚠️  No successful run in the last ${limit} runs — this cron has been stale for a while.`);

  const shapeCounts = {};

  for (const run of runs) {
    const jobsRaw = gh(['run', 'view', String(run.databaseId), '--json', 'jobs']);
    const { jobs } = JSON.parse(jobsRaw);
    const classifications = jobs.map((j) => ({ name: j.name, shape: classifyJob(j, timeouts) }));
    const notable = classifications.filter((c) => c.shape !== 'success' && c.shape !== 'skipped');

    console.log(`\n${run.createdAt}  [${run.event}]  run conclusion=${run.conclusion}`);
    for (const c of notable) {
      console.log(`    ${c.name}: ${c.shape}`);
      const bucket = c.shape.split(' (')[0];
      shapeCounts[bucket] = (shapeCounts[bucket] || 0) + 1;
    }
    if (notable.length === 0) console.log('    (all jobs succeeded)');
  }

  console.log('\n--- Summary across', runs.length, 'runs ---');
  const entries = Object.entries(shapeCounts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    console.log('No failing/cancelled jobs found — the workflow looks healthy over this window.');
  } else {
    for (const [shape, count] of entries) {
      console.log(`  ${shape}: ${count}`);
    }
    const top = entries[0];
    console.log(`\nDominant failure shape: "${top[0]}" (${top[1]} occurrences). ${
      top[0].startsWith('timeout-cancelled')
        ? 'Fix: give the underlying script a --time-budget-min wall-clock budget (scripts/lib/run-budget.js) well under the job timeout, so it stops cleanly instead of being SIGKILLed.'
        : top[0].startsWith('push-contention')
          ? 'Fix: check whether the committed files are eligible for scripts/lib/push-with-retry.sh\'s Git Data API fallback — see scripts/lib/core-data-merge-registry.js\'s apiFallbackSafe/apiFallbackMerge entries and scripts/lib/api-fallback-writer-drift.js to verify single-writer status before adding one.'
          : 'Inspect the named failing step directly — this shape is not one of the two known silent-staleness patterns.'
    }`);
  }
}

main().catch((err) => {
  console.error('💥 Fatal error:', err.message);
  process.exit(1);
});
