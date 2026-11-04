#!/usr/bin/env node
'use strict';
// BRO-5788: route each failing live-data test from check-corpus-drift.yml's
// "Live-data assertions" step through owner-alert-router. Usage:
//   node scripts/route-live-data-failures.js --tap=<file> --exit=<node --test exit code>
// Best-effort and always exits 0. The pass/fail verdict is the workflow's final step, from the new_failures output (BRO-6983).
const fs = require('node:fs');
const path = require('node:path');
const { parseTapOutput } = require('./lib/tap-failure-parser');
const { planLiveDataRouting, splitNewAndKnown, KEY_PREFIX } = require('./lib/live-data-routing');

async function main() {
  const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
  const tapPath = arg('tap');
  const exitCode = Number(arg('exit') || 0);
  let tap = '';
  try { tap = fs.readFileSync(tapPath, 'utf8'); } catch (e) {
    console.error(`::warning::[live-data-routing] cannot read TAP file "${tapPath}": ${e.message}; nothing resolved.`);
    if (exitCode === 0) return;
    tap = ''; // non-zero exit with no results file: route run-crashed below
  }
  const parsed = parseTapOutput(tap, path.resolve('.'));
  let router;
  try { router = require('./lib/owner-alert-router'); } catch (e) {
    console.error(`::warning::[live-data-routing] owner-alert-router unavailable: ${e.message}`);
    return;
  }
  const openKeys = Object.entries(router.loadLedger().conditions || {})
    .filter(([, c]) => c.status === 'open').map(([k]) => k).filter((k) => k.startsWith(KEY_PREFIX));
  const plan = planLiveDataRouting(parsed.failures, openKeys, parsed, exitCode);
  // BRO-6983: classify BEFORE routing (routing refreshes the ledger entries). The workflow's last
  // step fails the job only when new_failures is not 0, so known, owned failures stop reddening it.
  const { newKeys, knownKeys } = splitNewAndKnown(plan.route, router.loadLedger().conditions || {});
  console.log(`[live-data-routing] new=${newKeys.length} known(owned)=${knownKeys.length}`);
  for (const k of newKeys) console.log(`  NEW   ${k}`);
  for (const k of knownKeys) console.log(`  known ${k}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `new_failures=${newKeys.length}\n`);
  console.log(`[live-data-routing] tests=${parsed.totals.tests} fail=${parsed.totals.fail} exit=${exitCode} route=${plan.route.length} resolve=${plan.resolve.length}`);
  for (const r of plan.route) {
    try {
      const res = await router.routeAlert(r);
      console.log(`  routed ${r.conditionKey} -> ${JSON.stringify(res && (res.action || res.status || res)).slice(0, 160)}`);
    } catch (e) {
      console.error(`::warning::[live-data-routing] routeAlert failed for "${r.conditionKey}": ${e.message}`);
    }
  }
  for (const k of plan.resolve) {
    try { console.log(`  resolved ${k}: ${router.resolveCondition(k, { reason: 'live-data test green' })}`); } catch (e) {
      console.error(`::warning::[live-data-routing] resolveCondition failed for "${k}": ${e.message}`);
    }
  }
}
main().catch((e) => { console.error(`::warning::[live-data-routing] ${e.message}`); }).then(() => process.exit(0));
