#!/usr/bin/env node
'use strict';
/**
 * Opening-night lane, production run (BRO-4831). Arm-check, claim the night lease, run discovery -> fetch -> score ->
 * publish for the night window, release. Not scheduled by any workflow yet.
 *
 *   npx tsx scripts/opening-night-lane.js --show=ID --night=YYYY-MM-DD --core-dir=/tmp/core-data-checkout
 *       [--holder=gha-<run id>] [--adapters=config.json] [--max-age-hours=N] [--ledger-dir=DIR]
 *
 * tsx is needed because the ensemble scorer is TypeScript. --holder defaults to gha-$GITHUB_RUN_ID, else
 * local-<pid>-<epoch>, and must be unique per starter. Exit codes: see scripts/lib/opening-night-lane/driver.js.
 * A plain arm check without a run is `node scripts/opening-night-lane-rehearse.js --arm-check`.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const driver = require('./lib/opening-night-lane/driver');

const argv = process.argv.slice(2);
const arg = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;

async function main() {
  if (hasHelpFlag(argv)) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const repoDir = path.resolve(__dirname, '..');
  const showId = arg('show'); const night = arg('night'); const coreDir = arg('core-dir');
  if (!showId || !/^\d{4}-\d{2}-\d{2}$/.test(night || '') || !coreDir) { console.error('usage: --show=ID --night=YYYY-MM-DD --core-dir=PATH (see --help)'); return 2; }
  const holder = arg('holder') || (process.env.GITHUB_RUN_ID ? `gha-${process.env.GITHUB_RUN_ID}` : `local-${process.pid}-${Date.now()}`);
  const shows = JSON.parse(fs.readFileSync(path.join(repoDir, 'data', 'shows.json'), 'utf8'));
  const show = (Array.isArray(shows) ? shows : shows.shows || []).find((s) => s.id === showId);
  if (!show) { console.error(`unknown show ${showId}`); return 2; }
  if (!fs.existsSync(path.join(coreDir, 'reviews.json'))) { console.error(`--core-dir ${coreDir} has no reviews.json (want the core-data git checkout)`); return 2; }
  const hours = Number(arg('max-age-hours'));
  const deps = driver.buildRealLaneDeps({
    show, night, holder, repoDir, coreDir: path.resolve(coreDir),
    openingDate: show.openingDate, timeZone: show.market === 'west-end' ? 'Europe/London' : 'America/New_York',
    ledgerDir: path.resolve(arg('ledger-dir') || path.join(repoDir, 'data', 'opening-night', 'ledger')),
    recordFile: require('./lib/opening-night-lane/rehearsal').rehearsalRecordFile(repoDir, 'recorded'), // BRO-6619: a synthetic pass never arms
    maxAgeMs: hours > 0 ? hours * 60 * 60 * 1000 : undefined,
    adaptersConfig: arg('adapters') ? JSON.parse(fs.readFileSync(arg('adapters'), 'utf8')) : {},
    routeAlert: require('./lib/owner-alert-router').routeAlert,
    ScorerClass: require('./llm-scoring/ensemble-scorer.ts').EnsembleReviewScorer,
  });
  // BRO-6618: in the night workflow the lease outlives this process. The driver's `finally` calls deps.release, so swap in a
  // renewal (a fresh 30-minute TTL for the push) and let the workflow release it after push-review-texts succeeds.
  if (process.env.OPENING_NIGHT_LANE_RELEASE_BY_WORKFLOW === '1') {
    const renew = deps.heartbeat;
    deps.release = async () => {
      const r = await renew();
      console.log(r && r.ok ? 'opening-night lane: lease kept for the workflow to release after the review-texts push' : `opening-night lane: final lease renewal failed (${(r && r.reason) || 'unknown'}); the lease expires by TTL`);
    };
  }
  const out = await driver.runProductionLane({ show, night, holder, deps });
  console.log(JSON.stringify({ show: showId, night, holder, exit: out.exit, reason: out.reason, passes: out.result && out.result.passes }));
  // BRO-6620: lane-live's stood-down page step reads the reason (held-by-other is the second starter, not a page).
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `reason=${String(out.reason || '').replace(/[\r\n]/g, ' ')}\n`);
  return out.exit;
}

main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(`opening-night-lane: ${e.message}`); process.exitCode = 1; });
