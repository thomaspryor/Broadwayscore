#!/usr/bin/env node
/**
 * preflight-recovery-budget.js — pre-flight gate for Sprint 2/3 backfill operations.
 *
 * Dispatches `check-secrets-health.yml`, waits for completion, parses the logs,
 * and exits 0 (OK) or 1 (FAIL) based on ScrapingBee credit thresholds and
 * Bright Data zone status. Intended to gate bulk-collect-review-texts.yml and
 * backfill-aggregators.yml runs before they burn expensive credits.
 *
 * Usage:
 *   node scripts/preflight-recovery-budget.js --threshold-sb=40 --threshold-bd=enabled
 *   node scripts/preflight-recovery-budget.js --min-credits-remaining=50000 --threshold-bd=enabled
 *   node scripts/preflight-recovery-budget.js --threshold-sb=20 --min-credits-remaining=50000 --threshold-bd=enabled
 *
 * Args:
 *   --threshold-bd=<s>            Required. Must be "enabled". Bright Data zone must be active.
 *   --threshold-sb=<n>            Optional. Integer 0-100. SB % remaining must be >= this to pass.
 *                                 Use for opening-night protection ("preserve monthly allowance").
 *   --min-credits-remaining=<n>   Optional. Integer >= 0. Absolute SB credits remaining must be
 *                                 >= this value. Use for one-off backfills where % is misleading
 *                                 (e.g. 75% used but 1.3M credits remain — more than enough for
 *                                 a ~10K-credit operation).
 *
 *   At least one of --threshold-sb or --min-credits-remaining must be supplied.
 *   If both are given, both must pass (most conservative).
 *
 * Exit codes:
 *   0 — BUDGET_OK: all thresholds met (printed to stdout)
 *   1 — BUDGET_FAIL: one or more thresholds not met (printed to stderr)
 *   2 — script error: JSON parse failure, timeout, or missing args (printed to stderr)
 *
 * Log format parsed from check-secrets-health.js output:
 *   ScrapingBee: 1234 credits remaining (45% used)
 *   ScrapingBee: 75% credits used (1346447 remaining) — opening nights at risk
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

const hasSbPercent = !!args['threshold-sb'];
const hasMinCredits = args['min-credits-remaining'] !== undefined;

if (!args['threshold-bd']) {
  process.stderr.write(
    'Usage: node scripts/preflight-recovery-budget.js [--threshold-sb=<percent>] [--min-credits-remaining=<count>] --threshold-bd=enabled\n' +
    '  --threshold-sb              Integer 0-100; SB % remaining must be >= this value (opening-night protection)\n' +
    '  --min-credits-remaining     Integer >= 0; absolute SB credits remaining must be >= this value (one-off backfills)\n' +
    '  --threshold-bd              Must be "enabled"; Bright Data zone must be active\n' +
    '  At least one of --threshold-sb or --min-credits-remaining is required.\n' +
    '\nExit codes: 0=BUDGET_OK, 1=BUDGET_FAIL, 2=script error\n'
  );
  process.exit(2);
}

if (!hasSbPercent && !hasMinCredits) {
  process.stderr.write(
    'BUDGET_FAIL: must supply at least one of --threshold-sb=<percent> or --min-credits-remaining=<count>\n'
  );
  process.exit(2);
}

let thresholdSb = null;
if (hasSbPercent) {
  thresholdSb = parseInt(args['threshold-sb'], 10);
  if (isNaN(thresholdSb) || thresholdSb < 0 || thresholdSb > 100) {
    process.stderr.write(`ERROR: --threshold-sb must be an integer 0-100, got: ${args['threshold-sb']}\n`);
    process.exit(2);
  }
}

let minCreditsRemaining = null;
if (hasMinCredits) {
  minCreditsRemaining = parseInt(args['min-credits-remaining'], 10);
  if (isNaN(minCreditsRemaining) || minCreditsRemaining < 0) {
    process.stderr.write(`ERROR: --min-credits-remaining must be an integer >= 0, got: ${args['min-credits-remaining']}\n`);
    process.exit(2);
  }
}

const thresholdBd = args['threshold-bd'];

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
 * Parse the absolute ScrapingBee credits remaining from log output.
 * Uses the same log lines as parseSbPercent but extracts the raw count.
 * Returns the integer count, or null if unparseable.
 */
function parseSbCredits(logs) {
  // Format 1: "N credits remaining (P% used)" — N is the absolute count
  const m1 = logs.match(/ScrapingBee[^:]*:\s+([\d,]+) credits remaining \(\d+% used\)/);
  if (m1) return parseInt(m1[1].replace(/,/g, ''), 10);

  // Format 2: "P% credits used (N remaining)" — N is the absolute count
  const m2 = logs.match(/ScrapingBee[^:]*:\s+\d+% credits used \(([\d,]+) remaining\)/);
  if (m2) return parseInt(m2[1].replace(/,/g, ''), 10);

  // Format 3: exhausted
  if (/ScrapingBee[^:]*:\s+Credits exhausted/i.test(logs)) return 0;

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
  const sbPercent = parseSbPercent(logs);
  const sbCredits = parseSbCredits(logs);
  const bdStatus = parseBdStatus(logs);

  // Evaluate
  const failures = [];

  if (thresholdSb !== null) {
    if (sbPercent === null) {
      failures.push('SB=UNKNOWN (could not parse ScrapingBee % from logs)');
    } else if (sbPercent < thresholdSb) {
      failures.push(`SB=${sbPercent}% < ${thresholdSb}%`);
    }
  }

  if (minCreditsRemaining !== null) {
    if (sbCredits === null) {
      failures.push('SB=UNKNOWN (could not parse ScrapingBee credit count from logs)');
    } else if (sbCredits < minCreditsRemaining) {
      failures.push(`SB credits ${sbCredits} < ${minCreditsRemaining}`);
    }
  }

  if (bdStatus === null) {
    failures.push('BD=UNKNOWN (could not parse Bright Data status from logs)');
  } else if (bdStatus !== thresholdBd) {
    failures.push(`BD=${bdStatus} (expected ${thresholdBd})`);
  }

  const sbPercentDisplay = sbPercent !== null ? `${sbPercent}%` : 'UNKNOWN%';
  const sbCreditsDisplay = sbCredits !== null ? `${sbCredits} remaining` : 'UNKNOWN remaining';
  const bdDisplay = bdStatus !== null ? bdStatus : 'UNKNOWN';

  if (failures.length === 0) {
    process.stdout.write(`BUDGET_OK: SB=${sbPercentDisplay} (${sbCreditsDisplay}) BD=${bdDisplay}\n`);
    process.exit(0);
  } else {
    process.stderr.write(`BUDGET_FAIL: ${failures.join(', ')}\n`);
    process.exit(1);
  }
}

main();
