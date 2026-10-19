#!/usr/bin/env node
/**
 * Counts reviews whose publishDate is more than 2 days before opening night and
 * was not read from the page (needsOpeningWindowDateRecheck), split by whether
 * the recheck sweep already tried them (BRO-5717). New ones arrive through
 * aggregator, SERP and submit-form ingest that writes a date with no dateSource.
 * Advisory: exits 1 only when the unattempted count exceeds --max (default 40),
 * meaning backfill-review-dates --recheck-dates is due.
 */
const fs = require('fs');
const path = require('path');
const { needsOpeningWindowDateRecheck } = require('./lib/publish-date-provenance');

const max = parseInt((process.argv.find(a => a.startsWith('--max=')) || '--max=40').split('=')[1], 10);
const root = path.join(__dirname, '..', 'data', 'review-texts');
if (!fs.existsSync(root)) { console.log('data/review-texts not present: skipping'); process.exit(0); }
const shows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
const byId = new Map((Array.isArray(shows) ? shows : shows.shows).map(s => [s.id, s]));
let pending = 0, attempted = 0;
const bySource = {};
for (const d of fs.readdirSync(root)) {
  const dir = path.join(root, d);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (r.wrongProduction || r.wrongShow || !r.url) continue;
    if (!(r.needsDateRecheck === true || needsOpeningWindowDateRecheck(r, byId.get(d)))) continue;
    if (r.dateRecheckAttempted) { attempted++; continue; }
    pending++;
    const k = r.source || r.sourceType || 'unknown';
    bySource[k] = (bySource[k] || 0) + 1;
  }
}
console.log(`early/carried dates: ${pending} awaiting recheck, ${attempted} already attempted`);
console.log('awaiting by ingest source:', JSON.stringify(bySource));
if (pending > max) { console.log(`ADVISORY: ${pending} > ${max}: run backfill-review-dates with recheck_dates=true`); process.exit(1); }
