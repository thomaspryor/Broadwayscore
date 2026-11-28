#!/usr/bin/env node
/**
 * capped-workflow-dispatch.js (BRO-6532): dispatch a workflow only while fewer
 * than its cap of runs are in flight (scripts/lib/workflow-queue-cap.js).
 * Use it for every repeated dispatch of a bulk workflow (llm-ensemble-score,
 * ingest-urls, gather-reviews), from a session loop or a workflow step, so one
 * batch job cannot fill the account's ~40 runners and starve land.yml/test.yml.
 * Workflows without a cap are dispatched straight away.
 *
 * Usage:
 *   node scripts/capped-workflow-dispatch.js --workflow=ingest-urls.yml -f show_id=x -f urls="..."
 *     [--wait-min=N]  wait up to N minutes (max 9) for room, polling each minute.
 *                     Default 0. Never wait inside a CI runner: it holds one.
 *     [--priority]    opening-night work: skip the cap.
 *     [--ref=main] [--dry-run]
 *
 * Exit codes: 0 dispatched (or would be, with --dry-run); 3 DEFERRED, the cap
 * is full (not a failure: stop the loop and dispatch the rest later); 1 error.
 * A session loop should stop on the first 3:
 *   for s in a b c; do node scripts/capped-workflow-dispatch.js --workflow=... -f show_id=$s --wait-min=5 || break; done
 * Kill switch: WORKFLOW_CAP_DISABLED=1.
 */
'use strict';
require('./lib/cli-help').exitOnHelp(module);

const { checkCap } = require('./lib/workflow-queue-cap');
const { dispatch } = require('./lib/rest-dispatch');

const MAX_WAIT_MIN = 9; // under the 10-minute Bash tool limit, so a session's call is never killed mid-wait
const EXIT_DEFERRED = 3;

function parseArgs(argv) {
  const out = { inputs: {}, waitMin: 0, priority: false, dryRun: false, ref: 'main', workflow: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f' || a === '--field') {
      const kv = argv[++i] || '';
      const eq = kv.indexOf('=');
      if (eq < 1) throw new Error(`bad -f value "${kv}" (want key=value)`);
      out.inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith('--workflow=')) out.workflow = a.slice(11);
    else if (a.startsWith('--wait-min=')) out.waitMin = Math.min(MAX_WAIT_MIN, Math.max(0, Number(a.slice(11)) || 0));
    else if (a.startsWith('--ref=')) out.ref = a.slice(6);
    else if (a === '--priority') out.priority = true;
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`unknown argument "${a}"`);
  }
  if (!out.workflow) throw new Error('--workflow=<file.yml> is required');
  return out;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Check the cap, waiting up to waitMin minutes. Returns the last decision. */
function waitForRoom({ workflow, priority, waitMin, check = checkCap, wait = sleep, now = Date.now, log = console.log }) {
  const deadline = now() + waitMin * 60e3;
  for (;;) {
    const d = check({ workflow, priority, log });
    if (d.ok || now() + 60e3 > deadline) return d;
    log(`waiting: ${d.reason}`);
    wait(60e3);
  }
}

function main(argv = process.argv.slice(2), { check, send = dispatch, log = console.log } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) {
    console.error(`capped-workflow-dispatch: ${e.message}`);
    return 1;
  }
  const d = waitForRoom({ ...args, check, log });
  if (!d.ok) {
    log(`DEFERRED (not a failure): ${d.reason}. Dispatch it later.`);
    return EXIT_DEFERRED;
  }
  if (args.dryRun) {
    log(`would dispatch ${args.workflow} (${d.reason}) with ${JSON.stringify(args.inputs)}`);
    return 0;
  }
  try {
    send({ workflow: args.workflow, inputs: args.inputs, ref: args.ref });
  } catch (e) {
    console.error(`capped-workflow-dispatch: dispatch of ${args.workflow} failed: ${String(e.message).split('\n')[0]}`);
    return 1;
  }
  log(`dispatched ${args.workflow} (${d.reason})`);
  return 0;
}

module.exports = { parseArgs, waitForRoom, main, EXIT_DEFERRED, MAX_WAIT_MIN };

if (require.main === module) process.exit(main());
