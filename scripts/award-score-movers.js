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
 * Diff logic lives in scripts/lib/award-score-movers.js (shared with the
 * newsletter's own latestMovers() call).
 *
 * Usage:
 *   node scripts/award-score-movers.js --week-start=2026-05-16
 *   node scripts/award-score-movers.js --week-start=2026-05-16 --market=broadway --top=5
 *   node scripts/award-score-movers.js --week-start=2026-05-16 --end=2026-05-23
 */

const path = require('path');
const { resolveMoversForWeek } = require('./lib/award-score-movers');

const ROOT = path.resolve(__dirname, '..');
// Override for tests: see the matching comment in snapshot-award-scores.js.
const HISTORY_DIR = process.env.AWARD_SCORE_HISTORY_DIR || path.join(ROOT, 'data', 'award-score-history');

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

function main() {
  const args = parseArgs(process.argv);
  const result = resolveMoversForWeek({
    historyDir: HISTORY_DIR,
    weekStart: args.weekStart,
    end: args.end,
    market: args.market,
    top: args.top,
  });
  if (result.error) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

main();
