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

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');

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

/** Best-effort `timeout-minutes:` per job name, read straight from the workflow YAML. */
function readJobTimeouts(workflowFile) {
  const wfPath = path.join(__dirname, '..', '.github', 'workflows', workflowFile);
  const text = fs.readFileSync(wfPath, 'utf8');
  const lines = text.split('\n');
  const timeouts = {};
  let currentJob = null;
  // Jobs are top-level keys under `jobs:` at 2-space indent; `timeout-minutes:`
  // lines nested under a job are indented further. Good enough for this
  // repo's consistently-formatted workflow files — not a YAML parser.
  let inJobs = false;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const jobMatch = line.match(/^ {2}([a-zA-Z0-9_-]+):\s*$/);
    if (jobMatch) { currentJob = jobMatch[1]; continue; }
    const timeoutMatch = line.match(/^\s+timeout-minutes:\s*(\d+)/);
    if (timeoutMatch && currentJob) {
      timeouts[currentJob] = parseInt(timeoutMatch[1], 10);
    }
  }
  return timeouts;
}

function minutesBetween(startIso, endIso) {
  if (!startIso || !endIso) return null;
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000;
}

function classifyJob(job, timeouts) {
  if (job.conclusion === 'success' || job.conclusion === 'skipped') return job.conclusion;

  const durationMin = minutesBetween(job.startedAt, job.completedAt);
  const timeout = timeouts[job.name];

  if (job.conclusion === 'cancelled') {
    if (timeout != null && durationMin != null && durationMin >= timeout * 0.85) {
      return `timeout-cancelled (${durationMin.toFixed(0)}min vs ${timeout}min timeout)`;
    }
    return 'cancelled (not timeout-shaped — check for a concurrency cancel or manual stop)';
  }

  if (job.conclusion === 'failure') {
    const failedSteps = (job.steps || []).filter((s) => s.conclusion === 'failure');
    const pushStep = failedSteps.find((s) => /^(commit|push)\b/i.test(s.name));
    if (pushStep) return `push-contention (failed step: "${pushStep.name}")`;
    if (failedSteps.length) return `other failure (failed step: "${failedSteps[0].name}")`;
    return 'other failure';
  }

  return job.conclusion || 'unknown';
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

  const runsRaw = gh([
    'run', 'list',
    `--workflow=${workflowFile}`,
    `--limit=${limit}`,
    '--json', 'databaseId,conclusion,createdAt,event',
  ]);
  const runs = JSON.parse(runsRaw);

  if (runs.length === 0) {
    console.log('No runs found for this workflow.');
    return;
  }

  const lastSuccess = runs.find((r) => r.conclusion === 'success');
  console.log(lastSuccess
    ? `Last SUCCESSFUL run: ${lastSuccess.createdAt} (${lastSuccess.event}) — https://github.com/${runIdUrl()}`
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

  function runIdUrl() {
    try {
      const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
      return `${repo}/actions/runs/${lastSuccess.databaseId}`;
    } catch {
      return `actions/runs/${lastSuccess.databaseId}`;
    }
  }
}

main().catch((err) => {
  console.error('💥 Fatal error:', err.message);
  process.exit(1);
});
