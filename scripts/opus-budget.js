#!/usr/bin/env node
'use strict';

/**
 * opus-budget.js (BRO-6684): record or show the daily Opus budget (scripts/lib/opus-budget.js).
 *
 *   node scripts/opus-budget.js --record-usage --status=<status> --resets-at=<epoch seconds>
 *       Values come from get_session (no session_id): external_metadata.rate_limit_info
 *       with rateLimitType "seven_day". Saves them for this container's pickers (6h).
 *   node scripts/opus-budget.js            prints the current budget as JSON.
 * Exit 0 ok, 2 usage.
 */

const { hasHelpFlag } = require('./lib/cli-help.js');
const B = require('./lib/opus-budget.js');

const USAGE = 'Usage: node scripts/opus-budget.js [--record-usage --status=<allowed|allowed_warning|...> --resets-at=<epoch seconds>]';

function arg(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

async function main() {
  if (hasHelpFlag(process.argv)) {
    console.log(USAGE);
    return;
  }
  if (process.argv.includes('--record-usage')) {
    try {
      console.log(JSON.stringify(B.recordUsage({ status: arg('status'), resetsAt: arg('resets-at') })));
    } catch (e) {
      console.error(`${e.message}\n${USAGE}`);
      process.exit(2);
    }
  }
  require('./lib/load-env').loadEnv();
  const usage = B.readUsage();
  const budget = await B.loadOpusBudget({ usage });
  console.log(JSON.stringify({ disabled: B.disabled(), usage, budget }, null, 2));
}

main().catch((e) => {
  console.error(`[opus-budget] ${e && e.message ? e.message : e}`);
  process.exit(1);
});
