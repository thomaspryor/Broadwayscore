#!/usr/bin/env node
'use strict';
/**
 * Lane exit 3 inside the press-night window (BRO-6620, plan v2 step 2). Decision: standDownPage in
 * scripts/lib/opening-night-lane/lane-only-markets.js. Kept apart from scripts/lane-only-markets.js so the poller gate
 * and the marker step never load the alert router.
 *
 *   --show= --night= [--reason=] [--run-url=] [--dry-run] [--now=]
 *
 * Inside [embargo - 3h, embargo + 6h]: queues a digest row through routeAlert and exits 1, so the run goes red.
 * Exits 0 with a notice outside the window, for held-by-other (the second armed starter) and for LANE_STANDDOWN (the
 * owner's switch). not-armed skips the digest row (the driver already queued arm-refused) but still exits 1.
 * --dry-run skips routeAlert. --now= exists for tests.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const lom = require('./lib/opening-night-lane/lane-only-markets');

const argv = process.argv.slice(2);
const arg = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;

function findShow(id) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
  const list = Array.isArray(raw.shows) ? raw.shows : raw;
  return list.find((s) => s.id === id || s.slug === id) || null;
}

async function main() {
  let show = null;
  try { show = findShow(arg('show')); } catch (e) { console.log(`::warning::lane stood-down: cannot read shows.json (${String(e.message).slice(0, 120)})`); }
  const night = arg('night');
  const laneReason = arg('reason') || '';
  const d = lom.standDownPage({ show, night, now: arg('now') || undefined, laneReason });
  if (!d.page) { console.log(`::notice::opening-night lane stood down for ${arg('show')} (${night}), ${d.reason}; no page`); return 0; }
  console.log(`::error::opening-night lane stood down for ${arg('show')} (${night}) ${d.reason} (${laneReason || 'reason unknown'}); the old path publishes once the lease is released`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Lane stood down for ${arg('show')} (${night}) ${d.reason} (${laneReason || 'reason unknown'}): paged.\n`);
  if (argv.includes('--dry-run')) console.log('page=dry-run');
  else if (laneReason.startsWith('not-armed:')) console.log('page=driver-digest (arm-refused already queued)');
  else {
    const { routeAlert } = require('./lib/owner-alert-router');
    const res = await routeAlert({
      severity: 'error', disposition: 'digest', cooldownHours: 12,
      conditionKey: `opening-night-lane-stood-down:${arg('show')}:${night}`,
      title: `Opening-night lane stood down inside the press window for ${arg('show')} (${night})`,
      description: `The lane exited 3 (${laneReason || 'reason unknown'}) ${d.reason}. Once its lease is released the old path (Express, poller rebuild/deploy) publishes the night. Run: ${arg('run-url') || 'unknown'}`,
      url: arg('run-url') || undefined,
    });
    console.log(`page=${(res && res.action) || 'sent'}`);
  }
  // The digest row reaches the owner in the next Daily Digest; failing the step turns the run red. Notify on failure is
  // severity warning in opening-night-lane-live.yml, so it sends nothing tonight.
  return 1;
}

main().then((code) => process.exit(code), (e) => { console.log(`::error::lane stood-down: ${e && e.message}`); process.exit(1); });
