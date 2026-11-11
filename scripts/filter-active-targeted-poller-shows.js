#!/usr/bin/env node
/**
 * filter-active-targeted-poller-shows.js (BRO-7117)
 *
 * An auto/market opening-night poller run calls this so it never works on a
 * show that an active TARGETED poller run (run-name
 * `Opening Night Poller — <show_id>`) already owns. The two run kinds sit in
 * different concurrency groups (opening-night-poller.yml), so before this the
 * pair gathered, collected and scored the same show at the same time and one
 * of them failed (BRO-5716, BRO-6594, BRO-7338).
 *
 * Modes:
 *   node scripts/filter-active-targeted-poller-shows.js "show-a,show-b"
 *       prints the shows to KEEP (comma list, possibly empty); each dropped
 *       show is logged on stderr with the targeted run that owns it.
 *   node scripts/filter-active-targeted-poller-shows.js --active
 *       prints every show id an active targeted run owns (comma list).
 *
 * Fails OPEN: if the run list cannot be read (no gh, no token, API error,
 * 20s timeout), filter mode prints the input unchanged and --active prints
 * nothing, with a ::warning:: on stderr. A check that cannot run must never
 * stop the poller from polling. Same posture as filter-active-gather-shows.js.
 *
 * Needs no npm dependencies: the poller calls it before `npm ci`.
 */
'use strict';

const { execFileSync } = require('child_process');
const {
  activeTargetedPollerShows,
  partitionByActiveTargetedPoller,
} = require('./lib/poller-idempotency');

const USAGE = `filter-active-targeted-poller-shows.js — leave shows an active targeted opening-night poller run owns to that run (BRO-7117).

Usage:
  node scripts/filter-active-targeted-poller-shows.js "show-a,show-b"   # print shows to keep
  node scripts/filter-active-targeted-poller-shows.js --active          # print shows owned by active targeted runs`;

function listPollerRuns() {
  const out = execFileSync('gh', [
    'run', 'list', '--workflow=opening-night-poller.yml',
    '--json', 'databaseId,status,displayTitle', '--limit', '100',
  ], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
  const runs = JSON.parse(out);
  if (!Array.isArray(runs)) throw new Error('gh run list did not return an array');
  return runs;
}

function main(argv) {
  if (argv.some((a) => a === '--help' || a === '-h' || a.startsWith('--help='))) {
    console.log(USAGE);
    return;
  }
  const activeMode = argv.includes('--active');
  const wanted = activeMode ? [] : (argv.find((a) => !a.startsWith('--')) || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!activeMode && !wanted.length) {
    console.log('');
    return;
  }
  let runs;
  try {
    runs = listPollerRuns();
  } catch (e) {
    const why = String(e && e.message || e).split('\n')[0];
    console.error(`::warning::filter-active-targeted-poller-shows: could not list active poller runs (${why}); ${activeMode ? 'treating no show as owned' : 'keeping every show'}`);
    console.log(activeMode ? '' : wanted.join(','));
    return;
  }
  if (activeMode) {
    console.log([...activeTargetedPollerShows(runs).keys()].join(','));
    return;
  }
  const { keep, owned } = partitionByActiveTargetedPoller(runs, wanted);
  for (const o of owned) {
    console.error(`↪ ${o.showId}: left to targeted poller run ${o.runId ?? '?'} (BRO-7117)`);
  }
  console.log(keep.join(','));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
