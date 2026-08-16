#!/usr/bin/env node
'use strict';

/**
 * audit-headless-outcome-rate.js — the headless-lane counterpart to
 * audit-dispatch-dead-rate.js (card #1454). Prints the job-lane (headless)
 * success rate over a window, computed on job-* outcomes (job-done/
 * job-failed/job-orphaned/job-abandoned) rather than the cmux `dead` rows the
 * tab lane uses — those never get written for headless launches, so
 * `audit-dispatch-dead-rate.js --lane=headless` silently reads 0% dead
 * regardless of how many headless jobs actually failed. Prints the tab lane's
 * own dead-launch rate alongside it, same window, for direct comparison —
 * the card's own acceptance criterion ("a headless success rate computed
 * identically to the tab lane").
 *
 * All logic lives in the pure lib (CLAUDE.md rule 15) — this file is I/O and
 * formatting only.
 *
 * Usage:
 *   node scripts/audit-headless-outcome-rate.js               # last 14 days
 *   node scripts/audit-headless-outcome-rate.js --days=7
 *   node scripts/audit-headless-outcome-rate.js --json
 */

const fs = require('fs');
const path = require('path');
const {
  computeDeadRate, computeJobLaneOutcomeRate, CMUX_LANE, JOB_LANE,
} = require('./lib/dispatch-health.js');

const LEDGER = path.join(__dirname, '..', 'data', 'audit', 'dispatch-ledger.jsonl');
const DEFAULT_WINDOW_DAYS = 14; // card #1454's own measurement window

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function main() {
  const asJson = process.argv.includes('--json');
  const windowDays = Number(arg('days', DEFAULT_WINDOW_DAYS));

  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    console.error(`--days must be a positive number (got ${arg('days', '')})`);
    process.exit(2);
  }

  if (!fs.existsSync(LEDGER)) {
    // Not a silent zero: dispatch-ledger.jsonl is gitignored and per-machine,
    // so an absent file means "no visibility here", never "no failures".
    console.error(`No dispatch ledger at ${LEDGER} — it is gitignored and per-machine, written only where dispatches actually launch. Nothing to measure from this environment.`);
    process.exit(2);
  }

  const entries = fs.readFileSync(LEDGER, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const nowMs = Date.now();
  const headless = computeJobLaneOutcomeRate(entries, { nowMs, windowDays, lane: JOB_LANE });
  const tab = computeDeadRate(entries, { nowMs, windowDays, lane: CMUX_LANE });

  if (asJson) {
    console.log(JSON.stringify({ headless, tab }, null, 2));
    return;
  }

  console.log(`\nHeadless dispatch outcome rate — last ${windowDays}d (since ${headless.windowStartIso.slice(0, 16).replace('T', ' ')}Z)\n`);
  console.log(`  ${headless.launches} headless launches: ${headless.done} done, ${headless.failed} failed, ${headless.inFlight} in-flight, ${headless.none} with no job event yet`);
  if (headless.resolved === 0) {
    console.log('  success rate: unmeasurable (0 resolved launches — everything still in flight or unspawned)');
  } else {
    console.log(`  success rate (of ${headless.resolved} resolved): ${(headless.successRate * 100).toFixed(1)}%   failure rate: ${(headless.failureRate * 100).toFixed(1)}%`);
  }
  if (headless.failedTaskIds.length) {
    console.log(`  failed task(s) (${headless.failedTaskIds.length}): ${headless.failedTaskIds.join(', ')}`);
  }

  console.log(`\nTab-lane (cmux) dead-launch rate — same window, for comparison\n`);
  const tabPct = (tab.deadRate * 100).toFixed(1);
  console.log(`  ${tab.dead}/${tab.launches} tab launches never ran = ${tabPct}%`);
  console.log('');
}

if (require.main === module) main();

module.exports = { main };
