#!/usr/bin/env node
/**
 * cmux socket reachability sentinel (BRO-2992).
 *
 * Runs OUTSIDE cmux, on the same launchd cadence as the automations BRO-2959
 * showed can go silently blind to the socket (bsc-reconcile's tab self-heal,
 * bsc-prune, dispatch-watchdog). Decision logic lives in
 * scripts/lib/cmux-reachability-check.js — see that file's header for the
 * full rationale and why it's shared with health-check.js's row.
 *
 * MUST run on this Mac, not GitHub Actions — cmux.app never exists on a CI
 * runner, same reason check-hook-liveness.js and check-claude-auth-health.js
 * are Mac-only launchd jobs.
 *
 * Install:  cp scripts/launchd/com.broadwayscore.cmux-reachability.plist ~/Library/LaunchAgents/
 *           launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.broadwayscore.cmux-reachability.plist
 * Manual run:   launchctl kickstart -k gui/$(id -u)/com.broadwayscore.cmux-reachability
 * Manual check: node scripts/check-cmux-reachability.js
 */
'use strict';

const path = require('path');

require('./lib/load-env.js').loadEnv(path.join(__dirname, '..'));

const { runReachabilityCheck } = require('./lib/cmux-reachability-check.js');

async function main() {
  const row = await runReachabilityCheck({});
  console.log(`[cmux-reachability] ${row.status.toUpperCase()} ${row.name}: ${row.message}`);
  process.exit(row.status === 'error' ? 1 : 0);
}

main().catch((err) => {
  console.error('[cmux-reachability] check threw:', err);
  process.exit(1);
});
