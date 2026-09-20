#!/usr/bin/env node
/**
 * land-alert.js — land.yml's owner signal (BRO-3873 step 3), over
 * scripts/lib/land-alert.js. Writes the alert-router ledger + digest queue in
 * the job that calls it, so that job MUST commit data/audit/alert-ledger.json,
 * alert-digest-queue.json and alert-router-attempts.jsonl (lint-workflow-
 * guards.sh alert-ledger-commit enforces).
 *
 *   node scripts/land-alert.js --branch <land/x> --gate <name> [--run-url U] [--sha S] [--detail-file F]
 *   node scripts/land-alert.js --branch <land/x> --resolve
 */

'use strict';

const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { sendLandAlert, resolveLandAlert } = require('./lib/land-alert.js');

const USAGE = `land-alert.js — digest a red land.yml gate (routeAlert, conditionKey land:<branch>) or resolve it after a landing.

Usage:
  node scripts/land-alert.js --branch <land/x> --gate <name> [--run-url U] [--sha S] [--detail-file F]
  node scripts/land-alert.js --branch <land/x> --resolve
  --help, -h   print this and exit — no ledger writes`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const eq = t.indexOf('=');
    if (eq !== -1) { a[t.slice(2, eq)] = t.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { a[t.slice(2)] = next; i++; }
    else a[t.slice(2)] = true;
  }
  return a;
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const args = parseArgs(argv);
  if (!args.branch || args.branch === true) { console.error(USAGE); return 2; }
  if (args.resolve) {
    const did = resolveLandAlert(args.branch);
    console.log(`land-alert: ${did ? 'resolved' : 'nothing open for'} land:${String(args.branch).replace(/^refs\/heads\//, '')}`);
    return 0;
  }
  if (!args.gate || args.gate === true) { console.error(USAGE); return 2; }
  let detail = '';
  if (args['detail-file'] && args['detail-file'] !== true) {
    try { detail = fs.readFileSync(String(args['detail-file']), 'utf8'); } catch { detail = ''; }
  }
  const res = await sendLandAlert({
    branch: args.branch,
    gate: String(args.gate),
    runUrl: args['run-url'] && args['run-url'] !== true ? String(args['run-url']) : '',
    sha: args.sha && args.sha !== true ? String(args.sha) : '',
    detail,
  });
  console.log(`land-alert: ${res && res.action ? res.action : 'routed'} land:${String(args.branch).replace(/^refs\/heads\//, '')} (${args.gate})`);
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`land-alert: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, parseArgs };
