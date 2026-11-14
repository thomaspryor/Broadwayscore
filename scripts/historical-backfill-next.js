#!/usr/bin/env node
/**
 * historical-backfill-next.js — pick today's slice of the historical review
 * backfill and advance the cursor (BRO-4146).
 *
 * The backfill used to be a Mac launchd job (scripts/backfill-gather-batch.sh,
 * 04:00 ET) that dispatched one 100-show batch from scripts/backfill-batches.json
 * per day and kept its position in /tmp. Two problems: /tmp is cleared on
 * reboot, so it kept restarting from batch 0 (25 runs since 2026-08-26 over 12
 * batches), and a gather run only gets through ~25 of 100 shows before its
 * time budget, so the rest of each batch was silently skipped. It also landed
 * on the 08:00 UTC opening-night pass and held the review-write queue.
 *
 * This version runs in CI (historical-backfill.yml), stores the cursor in
 * data/audit/historical-backfill-cursor.json, and dispatches a slice small
 * enough to finish. When the list is exhausted it wraps to the start.
 *
 * Usage: node scripts/historical-backfill-next.js [--count=24] [--dry-run]
 * Writes `shows=<csv>` and `first=<id>` to $GITHUB_OUTPUT when set; prints the
 * slice otherwise. The workflow commits the cursor only after the dispatched
 * gather run has started (a queued run can be replaced in its concurrency group).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

const ROOT = path.join(__dirname, '..');
const BATCHES_PATH = path.join(ROOT, 'scripts', 'backfill-batches.json');
const CURSOR_PATH = path.join(ROOT, 'data', 'audit', 'historical-backfill-cursor.json');
const DEFAULT_COUNT = 24;

/** Pure: next `count` ids from `all` starting at cursor.next (wraps once). */
function nextBackfillSlice(all, cursor, count) {
  const list = [...new Set((all || []).filter(Boolean))];
  if (list.length === 0 || !(count > 0)) return { shows: [], next: 0, cycle: (cursor && cursor.cycle) || 0 };
  let next = Number.isInteger(cursor && cursor.next) ? cursor.next : 0;
  let cycle = Number.isInteger(cursor && cursor.cycle) ? cursor.cycle : 0;
  if (next < 0 || next >= list.length) { next = 0; cycle += 1; }
  const n = Math.min(count, list.length);
  const shows = [];
  for (let i = 0; i < n; i++) shows.push(list[(next + i) % list.length]);
  let after = next + n;
  if (after >= list.length) { after -= list.length; cycle += 1; }
  return { shows, next: after, cycle };
}

const USAGE = `historical-backfill-next.js — pick the next slice of the historical review backfill and advance its cursor.

Usage: node scripts/historical-backfill-next.js [--count=24] [--dry-run] [--force]
  --force     run even if today's slice was already dispatched
  --count=N   shows to pick (positive integer, default ${DEFAULT_COUNT})
  --dry-run   print the slice without writing the cursor`;

/** Pure: did the cursor advance earlier on the same UTC day as `nowMs`? */
function alreadyRanToday(cursor, nowMs = Date.now()) {
  const t = cursor && cursor.updatedAt ? new Date(cursor.updatedAt).getTime() : NaN;
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === new Date(nowMs).toISOString().slice(0, 10);
}

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const countArg = args.find((a) => a.startsWith('--count='));
  const count = countArg ? parseInt(countArg.split('=')[1], 10) : DEFAULT_COUNT;
  if (!(count >= 1)) {
    console.error(`--count must be a positive integer (got ${countArg}); cursor unchanged`);
    process.exit(2);
  }
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const all = JSON.parse(fs.readFileSync(BATCHES_PATH, 'utf8')).flat();
  let cursor = {};
  try { cursor = JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf8')); } catch { /* first run */ }
  // historical-backfill.yml has a backup cron (GitHub sometimes drops a
  // scheduled run, as it did for the first 06:37 run on 2026-10-09). Once
  // today's slice has started, later runs the same UTC day do nothing.
  if (!force && alreadyRanToday(cursor)) {
    console.log(`Historical backfill: today's slice already dispatched (cursor updated ${cursor.updatedAt}); nothing to do`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'shows=\nfirst=\n');
    return;
  }
  const { shows, next, cycle } = nextBackfillSlice(all, cursor, count);
  const from = (next - shows.length + all.length) % all.length;
  console.log(`Historical backfill: ${shows.length} show(s) from position ${from} of ${all.length} (cycle ${cycle}); next position ${next}`);
  console.log(shows.join(','));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `shows=${shows.join(',')}\n`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `first=${shows[0] || ''}\n`);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(CURSOR_PATH), { recursive: true });
    fs.writeFileSync(CURSOR_PATH, JSON.stringify({ next, cycle, total: all.length, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  }
}

if (require.main === module) main();
module.exports = { nextBackfillSlice, alreadyRanToday, DEFAULT_COUNT };
