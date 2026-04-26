#!/usr/bin/env node
/**
 * preflight-recovery-budget.js — pre-flight gate for Sprint 2/3 backfill operations.
 *
 * Dispatches `check-secrets-health.yml`, waits for completion, parses the logs,
 * and exits 0 (OK) or 1 (FAIL) based on ScrapingBee credit % remaining and
 * Bright Data zone status. Intended to gate bulk-collect-review-texts.yml and
 * backfill-aggregators.yml runs before they burn expensive credits.
 *
 * Usage:
 *   node scripts/preflight-recovery-budget.js --threshold-sb=40 --threshold-bd=enabled
 *   node scripts/preflight-recovery-budget.js --threshold-sb=25 --threshold-bd=enabled
 *
 * Args (both required):
 *   --threshold-sb=<n>   Integer 0-100. SB % remaining must be >= this to pass.
 *   --threshold-bd=<s>   Must be "enabled". Bright Data zone must be active.
 *
 * Exit codes:
 *   0 — BUDGET_OK: both SB and BD meet thresholds (printed to stdout)
 *   1 — BUDGET_FAIL: one or more thresholds not met (printed to stderr)
 *   2 — script error: JSON parse failure, timeout, or missing args (printed to stderr)
 *
 * Log format parsed from check-secrets-health.js output:
 *   ScrapingBee: 1234 credits remaining (45% used)
 *   ScrapingBee: 75% credits used (500 remaining) — opening nights at risk
 *   Bright Data: mcp_unlocker zone active
 *   Bright Data: Zone mcp_unlocker disabled: "..."
 */

'use strict';

const { execSync } = require('child_process');

// --- Argument parsing ---

function parseArgs(argv) {
  const args = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.+)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

const args = parseArgs(process.argv);

if (!args['threshold-sb'] || !args['threshold-bd']) {
  process.stderr.write(
    'Usage: node scripts/preflight-recovery-budget.js --threshold-sb=<percent> --threshold-bd=enabled\n' +
    '  --threshold-sb  Integer 0-100; ScrapingBee % remaining must be >= this value\n' +
    '  --threshold-bd  Must be "enabled"; Bright Data zone must be active\n' +
    '\nExit codes: 0=BUDGET_OK, 1=BUDGET_FAIL, 2=script error\n'
  );
  process.exit(2);
}

const thresholdSb = parseInt(args['threshold-sb'], 10);
const thresholdBd = args['threshold-bd'];

if (isNaN(thresholdSb) || thresholdSb < 0 || thresholdSb > 100) {
  process.stderr.write(`ERROR: --threshold-sb must be an integer 0-100, got: ${args['threshold-sb']}\n`);
  process.exit(2);
}

if (thresholdBd !== 'enabled') {
  process.stderr.write(`ERROR: --threshold-bd must be "enabled", got: ${thresholdBd}\n`);
  process.exit(2);
}

// --- gh helpers ---

function gh(cmd) {
  return execSync(`gh ${cmd}`, { encoding: 'utf8', timeout: 30000 });
}

function ghJson(cmd) {
  try {
    return JSON.parse(gh(cmd));
  } catch (err) {
    process.stderr.write(`ERROR: JSON parse failed for: gh ${cmd}\n${err.message}\n`);
    process.exit(2);
  }
}

// --- Workflow dispatch + poll ---

function dispatchAndGetRunId() {
  // Trigger a new run
  gh('workflow run check-secrets-health.yml');

  // Wait briefly so GitHub registers the new run before we query
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    // busy-wait; execSync blocks so we just need a short sleep equivalent
    execSync('sleep 3', { timeout: 5000 });
    const runs = ghJson('run list --workflow=check-secrets-health.yml --limit=3 --json databaseId,status,createdAt');
    if (runs.length > 0) {
      // Pick the most recent run (should be the one we just triggered)
      return runs[0].databaseId;
    }
  }
  process.stderr.write('ERROR: Could not find a run after dispatch\n');
  process.exit(2);
}

function waitForCompletion(runId) {
  const POLL_INTERVAL_MS = 15000;
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  const start = Date.now();

  process.stdout.write(`Waiting for run ${runId} to complete (timeout: 5 min)...\n`);

  while (Date.now() - start < TIMEOUT_MS) {
    execSync('sleep 15', { timeout: 20000 });

    const runs = ghJson(`run list --workflow=check-secrets-health.yml --limit=5 --json databaseId,status,conclusion`);
    const run = runs.find(r => r.databaseId === runId);

    if (!run) {
      process.stderr.write(`ERROR: Run ${runId} disappeared from list\n`);
      process.exit(2);
    }

    if (run.status === 'completed') {
      return run.conclusion;
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`  Still running... (${elapsed}s elapsed)\n`);
  }

  process.stderr.write(`ERROR: Run ${runId} did not complete within 5 minutes\n`);
  process.exit(2);
}

// --- Log parsing ---

/**
 * Parse ScrapingBee % remaining from log output.
 * The log line from check-secrets-health.js is one of:
 *   "✅ ScrapingBee: 1234 credits remaining (45% used)"
 *   "⚠️ ScrapingBee: 75% credits used (500 remaining) — opening nights at risk"
 *   "⚠️ ScrapingBee: 50% credits used (500 remaining) — monitor before opening nights"
 *   "❌ ScrapingBee: Credits exhausted (1000/1000 used)"
 * Returns the % REMAINING as an integer, or null if unparseable.
 */
function parseSbPercent(logs) {
  // Format 1: "N credits remaining (P% used)" → remaining = 100 - P
  const m1 = logs.match(/ScrapingBee[^:]*:\s+[\d,]+ credits remaining \((\d+)% used\)/);
  if (m1) return 100 - parseInt(m1[1], 10);

  // Format 2: "P% credits used (N remaining)" → remaining = 100 - P
  const m2 = logs.match(/ScrapingBee[^:]*:\s+(\d+)% credits used \([\d,]+ remaining\)/);
  if (m2) return 100 - parseInt(m2[1], 10);

  // Format 3: exhausted
  if (/ScrapingBee[^:]*:\s+Credits exhausted/i.test(logs)) return 0;

  // Format 4: skip / key not set
  if (/ScrapingBee[^:]*:\s+Key not set/i.test(logs)) return null;

  return null;
}

/**
 * Parse Bright Data zone status from log output.
 * The log line from check-secrets-health.js is one of:
 *   "✅ Bright Data: mcp_unlocker zone active"
 *   "✅ Bright Data: Zone mcp_unlocker was disabled (...). Auto-recovered: ..."
 *   "❌ Bright Data: Zone mcp_unlocker disabled: "...""
 *   "❌ Bright Data: Token invalid or unauthorized"
 * Returns "enabled" if zone is active/auto-recovered, "disabled" if not, null if unknown.
 */
function parseBdStatus(logs) {
  if (/Bright Data[^:]*:\s+.*zone active/i.test(logs)) return 'enabled';
  if (/Bright Data[^:]*:\s+.*Auto-recovered/i.test(logs)) return 'enabled';
  if (/Bright Data[^:]*:\s+.*disabled/i.test(logs)) return 'disabled';
  if (/Bright Data[^:]*:\s+.*invalid.*unauthorized/i.test(logs)) return 'disabled';
  if (/Bright Data[^:]*:\s+.*Token not set/i.test(logs)) return null;
  return null;
}

// --- Main ---

function main() {
  process.stdout.write(`Dispatching check-secrets-health.yml...\n`);

  let runId;
  try {
    runId = dispatchAndGetRunId();
  } catch (err) {
    process.stderr.write(`ERROR: Failed to dispatch workflow: ${err.message}\n`);
    process.exit(2);
  }

  process.stdout.write(`Run ID: ${runId}\n`);

  const conclusion = waitForCompletion(runId);
  process.stdout.write(`Run completed with conclusion: ${conclusion}\n`);

  // Pull logs
  let logs;
  try {
    logs = gh(`run view ${runId} --log`);
  } catch (err) {
    process.stderr.write(`ERROR: Failed to fetch run logs: ${err.message}\n`);
    process.exit(2);
  }

  // Parse
  const sbRemaining = parseSbPercent(logs);
  const bdStatus = parseBdStatus(logs);

  // Evaluate
  const failures = [];

  if (sbRemaining === null) {
    failures.push('SB=UNKNOWN (could not parse ScrapingBee % from logs)');
  } else if (sbRemaining < thresholdSb) {
    failures.push(`SB=${sbRemaining}% < ${thresholdSb}%`);
  }

  if (bdStatus === null) {
    failures.push('BD=UNKNOWN (could not parse Bright Data status from logs)');
  } else if (bdStatus !== thresholdBd) {
    failures.push(`BD=${bdStatus} (expected ${thresholdBd})`);
  }

  const sbDisplay = sbRemaining !== null ? `${sbRemaining}%` : 'UNKNOWN';
  const bdDisplay = bdStatus !== null ? bdStatus : 'UNKNOWN';

  if (failures.length === 0) {
    process.stdout.write(`BUDGET_OK: SB=${sbDisplay} BD=${bdDisplay}\n`);
    process.exit(0);
  } else {
    process.stderr.write(`BUDGET_FAIL: ${failures.join(', ')}\n`);
    process.exit(1);
  }
}

main();
