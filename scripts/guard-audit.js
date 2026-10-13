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

Env:
  BRIGHTDATA_ZONE              the web-unlocker zone whose trips stamp 'bd-budget' (default web_unlocker2)
  GUARD_AUDIT_SNAPSHOT_PATH    override the snapshot path (tests)
`);
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const core = require('./lib/guard-audit-core');
const { readLedger } = require('./lib/breaker-transitions');

const AUDIT = path.join(__dirname, '..', 'data', 'audit');
const SNAPSHOT = process.env.GUARD_AUDIT_SNAPSHOT_PATH || path.join(AUDIT, 'guard-audit-snapshot.json');
const THRESHOLDS = path.join(__dirname, 'config', 'provider-spend-thresholds.json');
const DRY_RUN = process.argv.includes('--dry-run');
const HTML = process.argv.includes('--html');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function readJsonl(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

async function main() {
  const bdZone = (process.env.BRIGHTDATA_ZONE || '').trim() || 'web_unlocker2';
  const bdState = readJson(path.join(AUDIT, 'bd-circuit-breaker.json'));
  const states = {
    'sd-circuit-breaker': readJson(path.join(AUDIT, 'sd-circuit-breaker.json')),
    'sb-circuit-breaker': readJson(path.join(AUDIT, 'sb-circuit-breaker.json')),
  };
  // bd-circuit-breaker.json holds one entry per zone under `zones`.
  for (const [zone, z] of Object.entries((bdState && bdState.zones) || {})) states[`bd-circuit-breaker-${zone}`] = z;
  const snapshot = core.runGuardAudit({
    ledger: readLedger(),
    spendRows: readJsonl(path.join(AUDIT, 'scraper-spend-ledger.jsonl')),
    dailyRows: readJsonl(path.join(AUDIT, 'provider-spend-daily.jsonl')),
    states,
    thresholds: readJson(THRESHOLDS) || {},
    prevSnapshot: readJson(SNAPSHOT),
    nowIso: new Date().toISOString(),
    bdZone,
  });

  if (HTML) { console.log(core.renderGuardAuditHtml(snapshot)); return; }
  console.log(snapshot.bannerText);
  for (const it of snapshot.items) console.log(`  ${it.title}: ${it.detail}`);
  if (DRY_RUN) { console.log('--dry-run: snapshot not written, alerts not routed'); return; }

  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Wrote ${SNAPSHOT}`);

  // One standing condition per guard. 168h cooldown: this is a weekly-cadence
  // finding re-evaluated daily, so it notifies at most once a week. The router
  // promotes a condition to an 'auto' Linear card after 14 notifies — ~14
  // weeks of a standing, unaddressed defect — which is deliberate. Only a
  // clean OK verdict resolves; UNCERTAIN (lower-bound count), NO DATA, SHADOW
  // and ACCEPTED neither alert nor resolve.
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
    } else if (g.verdict === 'OK') {
      resolveCondition(g.alertKey);
    }
  }
}

main().catch((err) => {
  console.error('guard-audit.js failed:', err.message);
  process.exit(1);
});
