#!/usr/bin/env node
'use strict';

/**
 * audit-pending-promotion-latency.js — how long press-night no-byline stubs sat
 * in _pending/ before promotion (BRO-7032).
 *
 *   node scripts/audit-pending-promotion-latency.js [--since=ISO] [--max-min=45] [--min-hot=N] [--json]
 *
 * Exit 0: no hot-span promotion slower than --max-min, and at least --min-hot hot-span promotions.
 * Exit 1: at least one press-night (hot-span) stub waited longer than --max-min.
 * Exit 2: bad arguments, or no review-texts checkout / shows.json to read.
 * Exit 3: fewer than --min-hot hot-span promotions in range (not enough evidence to call it).
 *
 * Stubs still in _pending/ from a hot span are listed (STRANDED) but never fail the run:
 * a page with no byline at all can never be promoted by the drain.
 */

const fs = require('fs');
const path = require('path');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { listShowDirs } = require('./lib/list-show-dirs');
const {
  promotionLatencies, slowHotSpanPromotions, hotSpanEvidence, strandedHotSpanStubs, median, DEFAULT_MAX_MIN,
} = require('./lib/pending-promotion-latency');

const USAGE = `audit-pending-promotion-latency.js — minutes a press-night no-byline review sat in _pending/
  --since=ISO     only reviews first seen at/after this time
  --max-min=N     hot-span promotion budget in minutes (default ${DEFAULT_MAX_MIN})
  --min-hot=N     exit 3 unless at least N hot-span promotions are in range (default 0)
  --json          machine-readable output`;

const die = (msg) => { console.error(`${msg}\n\n${USAGE}`); process.exit(2); };
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const VALUE_FLAGS = new Set(['since', 'max-min', 'min-hot']);
const opts = { json: false };
for (const a of args) {
  if (a === '--json') { opts.json = true; continue; }
  const m = /^--([a-z-]+)=(.+)$/.exec(a);
  if (!m || !VALUE_FLAGS.has(m[1])) die(`unknown or malformed argument: ${a}`);
  opts[m[1]] = m[2];
}
const since = opts.since || null;
if (since && !Number.isFinite(Date.parse(since))) die(`bad --since: ${since}`);
const maxMin = opts['max-min'] != null ? Number(opts['max-min']) : DEFAULT_MAX_MIN;
if (!Number.isFinite(maxMin) || maxMin < 0) die(`bad --max-min: ${opts['max-min']}`);
const minHot = opts['min-hot'] != null ? Number(opts['min-hot']) : 0;
if (!Number.isInteger(minHot) || minHot < 0) die(`bad --min-hot: ${opts['min-hot']}`);

const root = resolveReviewTextsDir();
if (!root || !fs.existsSync(root)) { console.error(`no review-texts checkout found (${root})`); process.exit(2); }
const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
let showsRaw;
try { showsRaw = JSON.parse(fs.readFileSync(showsPath, 'utf8')); } catch (e) { console.error(`cannot read ${showsPath}: ${e.message}`); process.exit(2); }
const showsById = new Map((Array.isArray(showsRaw) ? showsRaw : showsRaw.shows).map((s) => [s.id, s]));

function readShowDir(dir, showId, keep) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    let review;
    try { review = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
    if (keep(review)) out.push({ showId, file, review });
  }
  return out;
}

const records = [];
for (const showId of listShowDirs(root, { silent: true, skipHolding: true })) {
  if (showId.startsWith('.')) continue;
  records.push(...readShowDir(path.join(root, showId), showId, (r) => r && r.bylineSource === 'replay-pending-bylines'));
}
const pendingRoot = path.join(root, '_pending');
const pendingRecords = [];
if (fs.existsSync(pendingRoot)) {
  for (const showId of listShowDirs(pendingRoot, { silent: true })) pendingRecords.push(...readShowDir(path.join(pendingRoot, showId), showId, (r) => Boolean(r)));
}

const rows = promotionLatencies(records, showsById, { since });
const hot = hotSpanEvidence(rows);
const unknown = rows.filter((r) => r.hotSpan && r.unknownClock);
const slow = slowHotSpanPromotions(rows, maxMin);
const stranded = strandedHotSpanStubs(pendingRecords, showsById, { since, maxMin });
const insufficient = !slow.length && hot.length < minHot;
const verdict = slow.length ? 'FAIL' : insufficient ? 'INSUFFICIENT' : 'PASS';

if (opts.json) {
  console.log(JSON.stringify({
    reviewTexts: root, since, maxMin, minHot, verdict, promoted: rows.length, hotSpan: hot.length,
    hotSpanUnknownClock: unknown.length, hotSpanMedianMin: median(hot.map((r) => r.latencyMin)), slow, stranded,
  }, null, 2));
} else {
  console.log(`review-texts: ${root}`);
  console.log(`promoted from _pending${since ? ` since ${since}` : ''}: ${rows.length}; in press-night hot span: ${hot.length} (+${unknown.length} with an untrustworthy discovery clock, not counted); hot-span median ${median(hot.map((r) => r.latencyMin)) ?? '-'} min, max ${hot.length ? Math.max(...hot.map((r) => r.latencyMin)) : '-'} min`);
  for (const r of hot) console.log(`  ${slow.includes(r) ? 'SLOW' : 'ok  '} ${String(r.latencyMin).padStart(4)} min  ${r.firstSeenAt.slice(0, 16)}Z  ${r.showId}/${r.file}`);
  for (const s of stranded) console.log(`  STRANDED ${String(s.waitingMin).padStart(6)} min  ${s.firstSeenAt.slice(0, 16)}Z  _pending/${s.showId}/${s.file} (info only)`);
  if (verdict === 'FAIL') console.log(`FAIL: ${slow.length} press-night stub(s) waited more than ${maxMin} min in _pending/`);
  else if (verdict === 'INSUFFICIENT') console.log(`INSUFFICIENT: ${hot.length} press-night hot-span promotion(s) in range, need ${minHot}; no verdict yet`);
  else console.log(`PASS: no press-night stub waited more than ${maxMin} min (${hot.length} hot-span promotion(s) checked)`);
}
process.exit(verdict === 'FAIL' ? 1 : verdict === 'INSUFFICIENT' ? 3 : 0);
