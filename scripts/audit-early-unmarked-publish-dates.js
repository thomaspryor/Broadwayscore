#!/usr/bin/env node
/**
 * Counts reviews whose publishDate is more than 2 days before opening night and
 * was not read from the page (needsOpeningWindowDateRecheck), split by whether
 * the recheck sweep already tried them (BRO-5717). New ones arrive through
 * aggregator, SERP and submit-form ingest that writes a date with no dateSource.
 * --counts=PATH writes a counts-only snapshot for the health digest. Advisory: exits 1 only when the unattempted count exceeds --max (default 40),
 * meaning backfill-review-dates --recheck-dates is due. Counts what the sweep can reach: skip-listed
 * domains and unparseable URLs are reported as "unreachable". Exits 2 on a bad --max or unreadable shows.json.
 */
const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help.js');
if (hasHelpFlag(process.argv.slice(2))) { console.log('Usage:\n  node scripts/audit-early-unmarked-publish-dates.js [--max=40] [--counts=PATH]\n  --max=N      exit 1 when more than N early dates await recheck (default 40)\n  --counts=PATH write a counts-only JSON snapshot for the health digest\n  --help, -h   print this usage and exit'); process.exit(0); }
const path = require('path');
const { isDateRecheckCandidate } = require('./lib/publish-date-provenance');
const { SKIP_DOMAINS } = require('./lib/date-backfill-skip-domains');
const { listShowDirs } = require('./lib/list-show-dirs');

const maxArg = process.argv.find(a => a.startsWith('--max='));
const maxText = maxArg ? maxArg.split('=')[1] : '40';
const max = /^\d+$/.test(maxText) ? Number(maxText) : NaN;
if (!Number.isFinite(max)) { console.error(`Bad --max value: ${maxArg}`); process.exit(2); }
const root = path.join(__dirname, '..', 'data', 'review-texts');
if (!fs.existsSync(root)) { console.log('data/review-texts not present: skipping'); process.exit(0); }
let byId;
try {
  const sj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
  byId = new Map((sj.shows || sj).map(s => [s.id, s]));
} catch (e) { console.error(`Cannot read data/shows.json: ${e.message}`); process.exit(2); }
let pending = 0, attempted = 0, unreachable = 0;
const bySource = {}, byShow = {};
for (const d of listShowDirs(root, { silent: true })) {
  const dir = path.join(root, d);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!r || r.wrongProduction || r.wrongShow || !r.url) continue;
    if (!isDateRecheckCandidate(r, byId.get(d))) continue;
    if (r.dateRecheckAttempted) { attempted++; continue; }
    let domain;
    try { domain = new URL(r.url).hostname.replace(/^www\./, ''); } catch { unreachable++; continue; }
    if (SKIP_DOMAINS.has(domain)) { unreachable++; continue; }
    pending++;
    const k = r.source || r.sourceType || 'unknown';
    bySource[k] = (bySource[k] || 0) + 1;
    byShow[d] = (byShow[d] || 0) + 1;
  }
}
console.log(`early/carried dates: ${pending} awaiting recheck, ${attempted} already attempted, ${unreachable} unreachable (skip-listed domain or bad URL)`);
console.log('awaiting by ingest source:', JSON.stringify(bySource));
console.log('awaiting by show (top 10):', JSON.stringify(Object.entries(byShow).sort((a, b) => b[1] - a[1]).slice(0, 10)));
const countsArg = process.argv.find(a => a.startsWith('--counts='));
if (countsArg) {
  fs.writeFileSync(countsArg.split('=')[1], JSON.stringify({ generatedAt: new Date().toISOString(), awaiting: pending, attempted, max, bySource }, null, 2) + '\n');
}
if (pending > max) { console.log(`ADVISORY: ${pending} > ${max}: run backfill-review-dates with recheck_dates=true`); process.exit(1); }
