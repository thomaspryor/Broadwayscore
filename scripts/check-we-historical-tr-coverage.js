#!/usr/bin/env node
/**
 * BRO-6097: Theatre Record coverage for West End historical shows.
 * Per show: reviews TR lists for the production vs held vs counted; a show
 * with no TR match gets its reason. Exits 1 only on unexplained gaps.
 * Reads the probe written by we-historical-tr-probe.yml.
 *
 *   node scripts/check-we-historical-tr-coverage.js --seasons=2016-17..2021-22
 */
const fs = require('fs');
const path = require('path');
const { parseSeasonRange, buildCoverage } = require('./lib/we-historical-tr-coverage.js');

const root = path.join(__dirname, '..');
const arg = n => process.argv.slice(2).find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const spec = arg('seasons') || '2016-17..2021-22';
const range = parseSeasonRange(spec);
if (!range) { console.error(`Bad --seasons: ${spec}`); process.exit(2); }

const readJson = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const probeFile = arg('probe') || 'data/audit/we-historical-tr-probe.json';
const probe = fs.existsSync(path.join(root, probeFile)) ? readJson(probeFile) : { shows: {} };

const { rows, unexplained, ok } = buildCoverage({
  shows: readJson('data/shows.json').shows,
  reviews: readJson('data/reviews.json').reviews,
  probe, range,
});

const bySeason = {};
for (const r of rows) {
  const b = (bySeason[r.season] = bySeason[r.season] || { shows: 0, counted: 0, listed: 0, held: 0 });
  b.shows++; b.counted += r.counted; b.listed += r.listed || 0; b.held += r.held || 0;
}
for (const [s, b] of Object.entries(bySeason).sort()) {
  console.log(`${s}: ${b.shows} shows, counted avg ${(b.counted / b.shows).toFixed(1)}, TR listed ${b.listed}, held ${b.held}`);
}
const reasons = {};
for (const r of rows) if (r.reason) reasons[r.reason.replace(/^\d+-/, 'N-')] = (reasons[r.reason.replace(/^\d+-/, 'N-')] || 0) + 1;
console.log('Reasons:', JSON.stringify(reasons));
for (const r of unexplained.slice(0, 40)) console.log(`  UNEXPLAINED ${r.id} (${r.season}): ${r.reason}`);
if (unexplained.length > 40) console.log(`  ... and ${unexplained.length - 40} more`);
console.log(ok ? `OK: ${rows.length} shows, every gap explained` : `FAIL: ${unexplained.length}/${rows.length} shows with unexplained gaps`);
process.exit(ok ? 0 : 1);
