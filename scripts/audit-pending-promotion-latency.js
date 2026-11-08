#!/usr/bin/env node
'use strict';

/**
 * audit-pending-promotion-latency.js — how long press-night no-byline stubs sat
 * in _pending/ before promotion (BRO-7032).
 *
 *   node scripts/audit-pending-promotion-latency.js [--since=ISO] [--max-min=45] [--json]
 *
 * Exit 0: no hot-span promotion slower than --max-min (or none in range).
 * Exit 1: at least one press-night (hot-span) stub waited longer than --max-min.
 * Exit 2: no review-texts checkout to read.
 * Exit 3: fewer than --min-hot hot-span promotions in range (not enough evidence to call it).
 */

const fs = require('fs');
const path = require('path');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { promotionLatencies, slowHotSpanPromotions, median, DEFAULT_MAX_MIN } = require('./lib/pending-promotion-latency');

const USAGE = `audit-pending-promotion-latency.js — minutes a press-night no-byline review sat in _pending/
  --since=ISO     only reviews first seen at/after this time
  --max-min=N     hot-span promotion budget in minutes (default ${DEFAULT_MAX_MIN})
  --min-hot=N     exit 3 unless at least N hot-span promotions are in range (default 0)
  --json          machine-readable output`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const arg = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const since = arg('since');
const maxMin = arg('max-min') != null ? Number(arg('max-min')) : DEFAULT_MAX_MIN;
const minHot = arg('min-hot') != null ? Number(arg('min-hot')) : 0;
if (!Number.isInteger(minHot) || minHot < 0) { console.error(`bad --min-hot: ${arg('min-hot')}`); process.exit(2); }
if (since && !Number.isFinite(Date.parse(since))) { console.error(`bad --since: ${since}`); process.exit(2); }
if (!Number.isFinite(maxMin) || maxMin < 0) { console.error(`bad --max-min: ${arg('max-min')}`); process.exit(2); }

const root = resolveReviewTextsDir();
if (!root || !fs.existsSync(root)) { console.error(`no review-texts checkout found (${root})`); process.exit(2); }

const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
const showsRaw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const showsById = new Map((Array.isArray(showsRaw) ? showsRaw : showsRaw.shows).map((s) => [s.id, s]));

const records = [];
for (const showId of fs.readdirSync(root)) {
  if (showId.startsWith('_') || showId.startsWith('.')) continue;
  const dir = path.join(root, showId);
  let names;
  try { if (!fs.statSync(dir).isDirectory()) continue; names = fs.readdirSync(dir); } catch { continue; }
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    let review;
    try { review = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
    if (review && review.bylineSource === 'replay-pending-bylines') records.push({ showId, file, review });
  }
}

const rows = promotionLatencies(records, showsById, { since });
const hot = rows.filter((r) => r.hotSpan);
const slow = slowHotSpanPromotions(rows, maxMin);

if (args.includes('--json')) {
  console.log(JSON.stringify({ since, maxMin, promoted: rows.length, hotSpan: hot.length, hotSpanMedianMin: median(hot.map((r) => r.latencyMin)), slow }, null, 2));
} else {
  console.log(`review-texts: ${root}`);
  console.log(`promoted from _pending${since ? ` since ${since}` : ''}: ${rows.length}; in press-night hot span: ${hot.length}; hot-span median ${median(hot.map((r) => r.latencyMin)) ?? '-'} min, max ${hot.length ? Math.max(...hot.map((r) => r.latencyMin)) : '-'} min`);
  for (const r of hot) console.log(`  ${r.latencyMin > maxMin ? 'SLOW' : 'ok  '} ${String(r.latencyMin).padStart(4)} min  ${r.firstSeenAt.slice(0, 16)}Z  ${r.showId}/${r.file}`);
  console.log(slow.length ? `FAIL: ${slow.length} press-night stub(s) waited more than ${maxMin} min in _pending/` : `PASS: no press-night stub waited more than ${maxMin} min`);
}
if (slow.length) process.exit(1);
if (hot.length < minHot) {
  console.error(`INSUFFICIENT: ${hot.length} press-night hot-span promotion(s) in range, need ${minHot}`);
  process.exit(3);
}
process.exit(0);
