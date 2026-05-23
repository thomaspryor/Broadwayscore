#!/usr/bin/env node
/**
 * Compute Award Score Movers — top shows whose composite Site Award Score
 * moved most over a week-long window.
 *
 * Reads two snapshots from data/award-score-history/ (the --week-start date
 * and the most recent snapshot ≥ that date) and emits a JSON array of the
 * top N movers ranked by absolute delta.
 *
 * Designed to be machine-consumed by the weekly newsletter generator.
 *
 * Usage:
 *   node scripts/award-score-movers.js --week-start=2026-05-16
 *   node scripts/award-score-movers.js --week-start=2026-05-16 --market=broadway --top=5
 *   node scripts/award-score-movers.js --week-start=2026-05-16 --end=2026-05-23
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HISTORY_DIR = path.join(ROOT, 'data', 'award-score-history');

function parseArgs(argv) {
  const args = { weekStart: null, end: null, market: 'broadway', top: 5 };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--week-start=')) args.weekStart = a.slice('--week-start='.length);
    else if (a.startsWith('--end=')) args.end = a.slice('--end='.length);
    else if (a.startsWith('--market=')) args.market = a.slice('--market='.length);
    else if (a.startsWith('--top=')) args.top = parseInt(a.slice('--top='.length), 10);
    else if (a === '-h' || a === '--help') {
      console.log('Usage: award-score-movers.js --week-start=YYYY-MM-DD [--end=YYYY-MM-DD] [--market=broadway|west-end] [--top=5]');
      process.exit(0);
    }
  }
  if (!args.weekStart) {
    console.error('error: --week-start=YYYY-MM-DD is required');
    process.exit(2);
  }
  return args;
}

function snapshotFilename(date, market) {
  return market === 'broadway' ? `${date}.json` : `${date}-${market}.json`;
}

function loadSnapshot(date, market) {
  const p = path.join(HISTORY_DIR, snapshotFilename(date, market));
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listAvailableDates(market) {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  const suffix = market === 'broadway' ? /^(\d{4}-\d{2}-\d{2})\.json$/ : new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-${market}\\.json$`);
  return fs.readdirSync(HISTORY_DIR)
    .map((f) => {
      const m = f.match(suffix);
      return m ? m[1] : null;
    })
    .filter(Boolean)
    .sort();
}

function main() {
  const args = parseArgs(process.argv);
  const dates = listAvailableDates(args.market);
  if (dates.length === 0) {
    console.error(`error: no snapshots found in ${HISTORY_DIR} for market=${args.market}`);
    process.exit(1);
  }

  const before = loadSnapshot(args.weekStart, args.market);
  if (!before) {
    console.error(`error: no snapshot for week-start ${args.weekStart} (have: ${dates.join(', ')})`);
    process.exit(1);
  }

  // After = explicit --end, else latest snapshot on/after week-start.
  let afterDate = args.end;
  if (!afterDate) {
    const after = dates.filter((d) => d > args.weekStart);
    if (after.length === 0) {
      // Only one snapshot exists — emit empty deltas (newsletter generator
      // handles this gracefully) and exit 0 so cron doesn't alarm.
      const empty = {
        weekStart: args.weekStart,
        weekEnd: args.weekStart,
        market: args.market,
        movers: [],
        note: 'only one snapshot available; no comparison possible',
      };
      console.log(JSON.stringify(empty, null, 2));
      return;
    }
    afterDate = after[after.length - 1];
  }
  const after = loadSnapshot(afterDate, args.market);
  if (!after) {
    console.error(`error: no snapshot for end date ${afterDate}`);
    process.exit(1);
  }

  const allIds = new Set([...Object.keys(before.shows), ...Object.keys(after.shows)]);
  const rows = [];
  for (const id of allIds) {
    const b = before.shows[id];
    const a = after.shows[id];
    const beforeScore = b ? b.displayScore : 0;
    const afterScore = a ? a.displayScore : 0;
    const delta = afterScore - beforeScore;
    if (delta === 0) continue;
    rows.push({
      showId: id,
      title: (a && a.title) || (b && b.title) || id,
      before: beforeScore,
      after: afterScore,
      delta,
      // Surface whether the show was present in each snapshot so the
      // newsletter can distinguish "score moved" from "show opened/closed".
      presentBefore: !!b,
      presentAfter: !!a,
    });
  }
  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const top = rows.slice(0, args.top);
  const out = {
    weekStart: args.weekStart,
    weekEnd: afterDate,
    market: args.market,
    totalCompared: allIds.size,
    movedCount: rows.length,
    movers: top,
  };
  console.log(JSON.stringify(out, null, 2));
}

main();
