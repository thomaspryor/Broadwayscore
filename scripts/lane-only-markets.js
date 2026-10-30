#!/usr/bin/env node
'use strict';
/**
 * LANE_ONLY_MARKETS CLI (BRO-6620). Decision rules: scripts/lib/opening-night-lane/lane-only-markets.js.
 *
 *   gate --shows=a,b [--changed-dir=data/review-texts]
 *                          poller: writes suppress=true|false to GITHUB_OUTPUT (true only when every show stands down).
 *                          --changed-dir adds every show with uncommitted files there; an unreadable dir = suppress=false.
 *   decide --show=ID       print one decision as JSON
 *   mark --show= --night= --holder= [--run-id=]   lane-live: record the lane's exit 3
 *   stood-down --show= --night= [--reason=] [--run-url=] [--dry-run]   lane-live: on exit 3 inside the press-night window
 *                          (plan v2 step 2) queue a digest row through routeAlert and exit 1, so the job fails and its
 *                          "Notify on failure" pages now. Exit 0 with a notice outside the window, for held-by-other (the
 *                          second armed starter) and for LANE_STANDDOWN (the owner's switch). not-armed skips the digest
 *                          row (the driver already queued arm-refused) but still exits 1. --dry-run skips routeAlert.
 *
 * --markers-dir= and --now= exist for tests. Reads LANE_ONLY_MARKETS(+_READ=ok) and LANE_STANDDOWN(+_READ=ok) from the environment. Any error prints a
 * warning and leaves the old path on (exit 0, suppress=false): a gate that cannot decide never silences a night.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const lom = require('./lib/opening-night-lane/lane-only-markets');

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;

function findShowFactory() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
  const list = Array.isArray(raw.shows) ? raw.shows : raw;
  return (id) => list.find((s) => s.id === id || s.slug === id) || null;
}

function output(k, v) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}
function summary(line) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

async function stoodDown() {
  let show = null;
  try { show = findShowFactory()(arg('show')); } catch (e) { console.log(`::warning::lane-only markets: cannot read shows.json (${String(e.message).slice(0, 120)})`); }
  const night = arg('night');
  const laneReason = arg('reason') || '';
  const d = lom.standDownPage({ show, night, now: arg('now') || undefined, laneReason });
  if (!d.page) { console.log(`::notice::opening-night lane stood down for ${arg('show')} (${night}), ${d.reason}; no page`); return 0; }
  console.log(`::error::opening-night lane stood down for ${arg('show')} (${night}) ${d.reason} (${laneReason || 'reason unknown'}); the old path publishes once the lease is released`);
  summary(`Lane stood down for ${arg('show')} (${night}) ${d.reason} (${laneReason || 'reason unknown'}): paged.`);
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
  // severity warning in opening-night-lane-live.yml, so it sends nothing (a real-time page is BRO-6649's call).
  return 1;
}

function main() {
  if (cmd === 'stood-down') return stoodDown();
  if (cmd === 'mark') {
    const file = lom.writeMarker({ show: arg('show'), night: arg('night'), holder: arg('holder'), runId: arg('run-id'), dir: arg('markers-dir') || undefined });
    console.log(`lane-only markets: recorded the lane's exit 3 in ${path.relative(process.cwd(), file)}`);
    return 0;
  }
  if (cmd === 'gate' || cmd === 'decide') {
    let decider;
    try { decider = lom.createDecider({ findShow: findShowFactory(), markersDir: arg('markers-dir') || undefined, now: arg('now') || undefined }); } catch (e) {
      console.log(`::warning::lane-only markets: cannot decide (${String(e.message).slice(0, 160)}); old path stays on`);
      output('suppress', 'false');
      return 0;
    }
    if (decider.unknownTokens.length) console.log(`::warning::${lom.VARIABLE} has entries that are not a market or category (${decider.unknownTokens.join(', ')}); they match nothing, so the old path stays on for them`);
    if (cmd === 'decide') { console.log(JSON.stringify({ show: arg('show'), ...decider.decide(arg('show')) })); return 0; }
    const ids = String(arg('shows') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (arg('changed-dir')) {
      let porcelain;
      try {
        porcelain = require('child_process').execFileSync('git', ['-C', arg('changed-dir'), 'status', '--porcelain', '--untracked-files=all', '--', '.'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        console.log(`::warning::lane-only markets: cannot list changed shows in ${arg('changed-dir')} (${String(e.message).slice(0, 120)}); old path stays on`);
        output('suppress', 'false');
        return 0;
      }
      for (const id of lom.changedShowIds(porcelain)) if (!ids.includes(id)) ids.push(id);
    }
    const r = lom.pollerSuppress(ids, decider.decide);
    for (const d of r.decisions) console.log(`lane-only markets: ${d.id}: ${d.standDown ? 'old path stands down' : 'old path on'} (${d.reason})`);
    output('suppress', r.suppress ? 'true' : 'false');
    if (r.suppress) {
      const msg = `Lane-only markets (BRO-6620): rebuild + deploy skipped, the opening-night lane publishes ${ids.join(', ')}`;
      console.log(`::notice::${msg}`);
      summary(msg);
    } else if (!ids.length) {
      console.log('lane-only markets: no show had new work this run; nothing to gate');
    }
    return 0;
  }
  console.error('usage: lane-only-markets.js gate --shows=a,b | decide --show=ID | mark --show= --night= --holder= [--run-id=] | stood-down --show= --night= [--reason=] [--run-url=] [--dry-run]');
  return 2;
}

if (require.main === module) {
  Promise.resolve().then(main).then((code) => process.exit(code), (e) => {
    console.log(`::${cmd === 'stood-down' ? 'error' : 'warning'}::lane-only markets: ${String(e && e.message).slice(0, 200)}`);
    if (cmd === 'gate') output('suppress', 'false');
    process.exit(cmd === 'mark' || cmd === 'stood-down' ? 1 : 0);
  });
}

module.exports = { main };
