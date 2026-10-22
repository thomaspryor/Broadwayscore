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
 * Uses authenticated `gh` when available, with a public REST fallback.
 * Read-only: makes no writes and triggers no runs.
 */

'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const { collectDiagnosis, formatDiagnosis } = require('./lib/cron-health-chronic-diagnosis.js');

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

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }

  const flags = parseArgs(process.argv.slice(2));
  const workflowFile = flags.workflow;
  if (!workflowFile) {
    console.error('Usage: node scripts/cron-health-chronic-orchestrator.js --workflow=<file.yml> [--limit=N]');
    process.exit(1);
  }
  const limit = flags.limit === undefined ? 15 : Number(flags.limit);
  const diagnosis = collectDiagnosis({ workflowFile, limit });
  console.log(formatDiagnosis(diagnosis));
}

main().catch((err) => {
  console.error('💥 Fatal error:', err.message);
  process.exit(1);
});
