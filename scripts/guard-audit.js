#!/usr/bin/env node
/**
 * BRO-3011: spend-guard audit (Sprint 3). Daily producer (data-health-check.yml)
 * of data/audit/guard-audit-snapshot.json for the morning digest; the weekly
 * scraper cost report embeds the same audit via --html. Logic:
 * scripts/lib/guard-audit-core.js.
 *
 *   node scripts/guard-audit.js            write the snapshot, route DEFECT / drift alerts
 *   node scripts/guard-audit.js --dry-run  print the snapshot; no writes, no alerts
 *   node scripts/guard-audit.js --html     print the email section; no writes, no alerts
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(`guard-audit.js — weekly spend-guard audit (BRO-3011)

  node scripts/guard-audit.js            write the snapshot, route DEFECT / cap-drift alerts
  node scripts/guard-audit.js --dry-run  print the snapshot JSON; no writes, no alerts
  node scripts/guard-audit.js --html     print the cost-report HTML section; no writes, no alerts
                                         (the weekly report uses scripts/render-guard-audit.js, which cannot alert)

Env:
  BRIGHTDATA_ZONE              the web-unlocker zone whose trips stamp 'bd-budget' (default web_unlocker2)
  GUARD_AUDIT_SNAPSHOT_PATH    override the snapshot path (tests)
`);
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const { runGuardAuditFromFiles, DEFAULT_SNAPSHOT_PATH } = require('./lib/guard-audit-io');
const { renderGuardAuditHtml } = require('./lib/guard-audit-core');

const SNAPSHOT = process.env.GUARD_AUDIT_SNAPSHOT_PATH || DEFAULT_SNAPSHOT_PATH;
const DRY_RUN = process.argv.includes('--dry-run');
const HTML = process.argv.includes('--html');

async function main() {
  const snapshot = runGuardAuditFromFiles({ snapshotPath: SNAPSHOT });

  if (HTML) { console.log(renderGuardAuditHtml(snapshot)); return; }
  console.log(snapshot.bannerText);
  for (const it of snapshot.items) console.log(`  ${it.title}: ${it.detail}`);
  if (DRY_RUN) { console.log('--dry-run: snapshot not written, alerts not routed'); return; }

  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Wrote ${SNAPSHOT}`);

  // One standing condition per guard. 168h cooldown: this is a weekly-cadence
  // finding re-evaluated daily, so it notifies at most once a week. The router
  // promotes a condition to an 'auto' Linear card after 14 notifies — ~14
  // weeks of a standing, unaddressed defect — which is deliberate. OK and
  // ACCEPTED resolve (ACCEPTED never alerts); UNCERTAIN (lower-bound count),
  // NO DATA and SHADOW neither alert nor resolve.
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');
  for (const g of snapshot.guards) {
    if (g.shadow) continue;
    const isDefect = g.verdict === 'DEFECT';
    const isDrift = g.drift.drift;
    if (isDefect || isDrift) {
      const why = [isDefect ? `tripped on ${g.days} of the last 7 days (${g.dayList.join(', ')})` : null,
        isDrift ? `ceiling ${g.drift.ceiling} (${g.drift.source || 'unknown'}) is below 1.5x the 14-day median demand ${g.drift.median14d}` : null].filter(Boolean).join('; ');
      await routeAlert({
        conditionKey: g.alertKey,
        title: `Spend guard ${g.key}: ${isDefect ? 'DEFECT' : 'cap drift'}`,
        description: `${g.key} ${why}. A guard that trips more than 2 days a week is mis-sized (or its provider needs an owner-accepted exemption in scripts/config/provider-spend-thresholds.json acceptedDailyTrip). Rerouted spend on trip days: ${g.spend.note || `$${g.spend.usd.toFixed(2)}`}.`,
        severity: 'warning',
        disposition: 'digest',
        cooldownHours: 168,
      });
    } else if (g.verdict === 'OK' || g.verdict === 'ACCEPTED') {
      // ACCEPTED resolves too: a DEFECT the owner then accepts via
      // acceptedDailyTrip must not stay open forever (review finding).
      resolveCondition(g.alertKey);
    }
  }
}

main().catch((err) => {
  console.error('guard-audit.js failed:', err.message);
  process.exit(1);
});
