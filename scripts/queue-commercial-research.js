#!/usr/bin/env node
'use strict';

/**
 * CLI wrapper for data/commercial-research-queue.json writers. Replaces the
 * three inline `node -e` heredocs in update-show-status.yml with a testable
 * script — see scripts/lib/commercial-queue.js for the decision logic.
 *
 * Usage:
 *   node scripts/queue-commercial-research.js --new-slugs=a,b,c [--dry-run]
 *   node scripts/queue-commercial-research.js --pre-opening [--dry-run]
 *   node scripts/queue-commercial-research.js --closing [--dry-run]
 *
 * Exactly one of --new-slugs / --pre-opening / --closing is required.
 */

const fs = require('fs');
const path = require('path');
const {
  filterNewBroadwayShows,
  filterPreOpeningShows,
  filterClosingTbdShows,
  addToQueue,
} = require('./lib/commercial-queue');

const ROOT = path.join(__dirname, '..');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');
const COMMERCIAL_FILE = path.join(ROOT, 'data', 'commercial.json');
const QUEUE_FILE = path.join(ROOT, 'data', 'commercial-research-queue.json');

const args = process.argv.slice(2);
const flags = {};
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v === undefined ? true : v;
  }
}
const DRY_RUN = flags['dry-run'] === true;

function loadJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function main() {
  const shows = (loadJSON(SHOWS_FILE, { shows: [] }).shows) || [];
  const commercial = loadJSON(COMMERCIAL_FILE, { shows: {} });
  const queue = loadJSON(QUEUE_FILE, { shows: [], triggers: {} });

  let slugs;
  let trigger;

  if (flags['new-slugs'] !== undefined) {
    const raw = typeof flags['new-slugs'] === 'string' ? flags['new-slugs'] : '';
    const candidates = raw.split(',').filter(Boolean);
    slugs = filterNewBroadwayShows(candidates, shows);
    trigger = 'new-show';
    if (slugs.length === 0) {
      console.log('No Broadway shows to queue');
      return 0;
    }
    console.log(`Queued ${slugs.length} Broadway shows for commercial research: ${slugs.join(', ')}`);
  } else if (flags['pre-opening'] !== undefined) {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    slugs = filterPreOpeningShows(shows, commercial, tomorrowStr);
    trigger = 'pre-opening';
    if (slugs.length === 0) {
      console.log('No pre-opening shows for tomorrow');
      return 0;
    }
    console.log(`Queued ${slugs.length} pre-opening shows: ${slugs.join(', ')}`);
  } else if (flags['closing'] !== undefined) {
    const weekAgo = new Date();
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];
    const todayStr = new Date().toISOString().split('T')[0];
    slugs = filterClosingTbdShows(shows, commercial, weekAgoStr, todayStr);
    trigger = 'closing';
    if (slugs.length === 0) {
      console.log('No recently closed TBD shows');
      return 0;
    }
    console.log(`Queued ${slugs.length} closing TBD shows: ${slugs.join(', ')}`);
  } else {
    console.error('Usage: --new-slugs=a,b,c | --pre-opening | --closing [--dry-run]');
    return 2;
  }

  const nextQueue = addToQueue(queue, slugs, trigger);

  if (DRY_RUN) {
    console.log('[dry-run] would write:', JSON.stringify(nextQueue, null, 2));
    return 0;
  }

  fs.writeFileSync(QUEUE_FILE, JSON.stringify(nextQueue, null, 2) + '\n');
  return 0;
}

process.exitCode = main();
