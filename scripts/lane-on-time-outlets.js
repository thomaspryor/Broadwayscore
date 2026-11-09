#!/usr/bin/env node
'use strict';
/**
 * Lists the outlets that published on time on recent Broadway opening nights, and whether the opening-night lane polls a
 * source for each (BRO-6872). --write refreshes the committed snapshot that tests/unit/opening-night-lane-sources.test.mjs
 * checks, so the test keeps failing for an outlet with no source even where data/reviews.json is not present (CI).
 *
 * Usage: node scripts/lane-on-time-outlets.js [--write] [--months=12] [--min-nights=2]
 */
const fs = require('fs');
const path = require('path');
const { onTimeOutlets, laneSourceCoverage } = require('./lib/opening-night-lane/lane-sources');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/opening-night-lane/on-time-outlets.json');

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 10).join('\n')); return 0; }
  const arg = (k, d) => {
    const a = argv.find((x) => x.startsWith(`--${k}=`));
    if (!a) return d;
    const n = Number(a.split('=')[1]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${k} needs a positive number, got ${a}`);
    return n;
  };
  const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
  let reviews; let shows;
  try { reviews = readJson('data/reviews.json'); shows = readJson('data/shows.json'); } catch (e) {
    console.error(`data/reviews.json or data/shows.json missing (${e.message}); run scripts/setup-local-data.sh`); return 2;
  }
  reviews = Array.isArray(reviews) ? reviews : (reviews.reviews || Object.values(reviews));
  shows = Array.isArray(shows) ? shows : (shows.shows || Object.values(shows));
  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - arg('months', 12) * 30.44 * 86400000).toISOString().slice(0, 10);
  const minNights = arg('min-nights', 2);
  const outlets = onTimeOutlets(reviews, shows, { since, until, minNights });
  const cov = laneSourceCoverage(outlets.map((o) => o.outletId));
  for (const o of outlets) {
    const c = cov.covered[o.outletId] ? cov.covered[o.outletId][0] : cov.gaps[o.outletId] ? `GAP: ${cov.gaps[o.outletId]}` : 'MISSING';
    console.log(`${String(o.nights).padStart(3)}  ${o.outletId.padEnd(28)} ${c}`);
  }
  console.log(`\n${outlets.length} outlets, ${Object.keys(cov.covered).length} polled, ${Object.keys(cov.gaps).length} gaps with a reason, ${cov.missing.length} missing${cov.missing.length ? `: ${cov.missing.join(', ')}` : ''}`);
  if (argv.includes('--write')) {
    fs.writeFileSync(FIXTURE, `${JSON.stringify({ generatedAt: until, since, until, minNights, outlets }, null, 2)}\n`);
    console.log(`wrote ${path.relative(ROOT, FIXTURE)}`);
  }
  return cov.missing.length ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (e) { console.error(e.message); process.exitCode = 2; }
}
module.exports = { main };
