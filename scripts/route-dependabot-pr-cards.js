#!/usr/bin/env node
/**
 * route-dependabot-pr-cards.js — one owner-alert-router 'auto' card per open
 * Dependabot PR, and resolve the condition of every PR that is no longer open
 * (BRO-5631, BRO-6445). Run by dependabot-auto-merge.yml ("Dependabot PR Cards").
 *
 * Before BRO-6445 this lived inline in the workflow and never resolved
 * anything, so a PR a worker closed kept its dependabot-pr:<N> condition open
 * and the card's check-alert-condition-absent VERIFY never passed.
 *
 * Usage: PRS_JSON=<file from gh pr list --state open --limit 50> \
 *          node scripts/route-dependabot-pr-cards.js [--dry-run]
 *   --dry-run  print what would be filed and resolved; touch nothing
 *
 * Exit: 0 ok · 1 routeAlert failed · 2 usage (PRS_JSON missing/unreadable)
 */
'use strict';

const fs = require('fs');
const { dependabotPrAlerts, staleDependabotPrKeys } = require('./lib/dependabot-pr-cards.js');

// Must match --limit in dependabot-auto-merge.yml's gh pr list.
const LIST_LIMIT = 50;

async function main(argv = process.argv.slice(2), env = process.env) {
  const dryRun = argv.includes('--dry-run');
  let prs;
  try {
    prs = JSON.parse(fs.readFileSync(env.PRS_JSON || '', 'utf8'));
  } catch (e) {
    console.error(`PRS_JSON unreadable (${env.PRS_JSON || 'unset'}): ${e.message}`);
    return 2;
  }
  if (!Array.isArray(prs)) {
    console.error('PRS_JSON is not a JSON array');
    return 2;
  }
  const router = require('./lib/owner-alert-router.js');
  const alerts = dependabotPrAlerts(prs);
  for (const a of alerts) {
    if (dryRun) { console.log(`${a.conditionKey}: would route`); continue; }
    const result = await router.routeAlert({ ...a, severity: 'warning', disposition: 'auto', cooldownHours: 24 * 30,
      fields: [{ name: 'PR', value: a.url }] });
    console.log(`${a.conditionKey}: ${result.action}`);
  }
  if (!alerts.length) console.log('no open Dependabot PRs');

  if (prs.length >= LIST_LIMIT) console.log(`listing hit --limit ${LIST_LIMIT}; not resolving closed PRs this run`);
  const stale = staleDependabotPrKeys(router.loadLedger().conditions, prs, { limit: LIST_LIMIT });
  for (const key of stale) {
    if (dryRun) { console.log(`${key}: would resolve (PR no longer open)`); continue; }
    const done = router.resolveCondition(key, { reason: 'Dependabot PR no longer open (closed or merged)' });
    console.log(`${key}: ${done ? 'resolved' : 'already resolved'} (PR no longer open)`);
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error('routeAlert failed:', e.message); process.exit(1); });
}

module.exports = { main, LIST_LIMIT };
