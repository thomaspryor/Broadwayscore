#!/usr/bin/env node
/**
 * outlet-heartbeat-monitor.js — standalone CLI for the "Quality:
 * outlet-heartbeat red flags" BSC Daily signal (BRO-2521).
 *
 * Before this existed, diagnosing that alert meant either running the full
 * scripts/health-check.js digest (dozens of unrelated checks) or manually
 * reading data/audit/outlet-heartbeat*.json. This runs just that one signal.
 *
 * The signal itself is computed weekly by audit-critic-coverage.yml (via
 * scripts/audit-critic-coverage.js's heartbeat section + outlet-cadence.js)
 * and persisted to data/audit/outlet-heartbeat.json /
 * outlet-heartbeat-state.json. This script only reads those snapshots — it
 * does not re-scrape. To investigate a specific flagged outlet (stopped
 * reviewing vs. extractor broke), use scripts/monitor-outlet-recency.js,
 * which recomputes live off current reviews.json/outlet-registry.json.
 *
 * Usage:
 *   node scripts/outlet-heartbeat-monitor.js         # print signal, exit 1 if warn
 *   node scripts/outlet-heartbeat-monitor.js --json   # machine-readable output
 */
'use strict';

const { evaluateOutletHeartbeat } = require('./lib/outlet-heartbeat-monitor-core');

function main() {
  const jsonOut = process.argv.includes('--json');
  let result;
  try {
    result = evaluateOutletHeartbeat();
  } catch (err) {
    // Same shape health-check.js's runCheck() falls back to on a crash, so
    // --json callers can rely on `status` always being present.
    result = { name: 'Quality: outlet-heartbeat red flags', status: 'error', message: `Check crashed: ${err.message}` };
  }

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const icon = result.status === 'pass' ? 'PASS' : result.status === 'error' ? 'ERROR' : 'WARN';
    console.error(`[${icon}] ${result.name}: ${result.message}`);
    if (result.hint) console.error(`  hint: ${result.hint}`);
    if (result.actionable?.length) {
      for (const r of result.actionable) {
        console.error(`  RED  ${r.outletId} / ${r.market}  silent ${r.silentDays}d (threshold ${r.thresholdDays}d)`);
      }
    }
  }

  process.exit(result.status === 'pass' ? 0 : 1);
}

if (require.main === module) main();

module.exports = { evaluateOutletHeartbeat };
