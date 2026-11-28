#!/usr/bin/env node
'use strict';
/**
 * Lists the outlets that published on time on recent Broadway opening nights, and whether the opening-night lane polls a
 * source for each (BRO-6872). --write refreshes the committed snapshot that tests/unit/opening-night-lane-sources.test.mjs
 * checks, so the test keeps failing for an outlet with no source even where data/reviews.json is not present (CI).
 *
 * --per-show=N (BRO-7199) instead checks the final review set of each of the last N Broadway openings: every outlet in
 * it must be reachable by a lane source of its own (feed or section page) or carry a stated gap. Exits 1 when an outlet
 * that published on time has neither. Late outlets are listed for information only.
 *
 * Usage: node scripts/lane-on-time-outlets.js [--write] [--months=12] [--min-nights=2] | --per-show=10
 */
const fs = require('fs');
const path = require('path');
const { onTimeOutlets, laneSourceCoverage } = require('./lib/opening-night-lane/lane-sources');
const { isBroadwayCategory } = require('./lib/venue-classification');

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
  if (argv.some((a) => a.startsWith('--per-show='))) return perShow(reviews, shows, { count: arg('per-show', 10), until });
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

/** Per-show coverage of the final review set for the last `count` Broadway openings with reviews (BRO-7199). */
function perShow(reviews, shows, { count, until }) {
  const byShow = new Map();
  for (const r of reviews) if (r.showId && r.outletId) (byShow.get(r.showId) || byShow.set(r.showId, []).get(r.showId)).push(r);
  const recent = shows.filter((s) => isBroadwayCategory(s) && s.openingDate && String(s.openingDate).slice(0, 10) <= until && byShow.has(s.id))
    .sort((a, b) => String(b.openingDate).localeCompare(String(a.openingDate))).slice(0, count);
  const DAY = 86400000;
  let onTimeMissing = 0;
  for (const s of recent) {
    const night = String(s.openingDate).slice(0, 10);
    const plus1 = new Date(Date.parse(night) + DAY).toISOString().slice(0, 10);
    const minus1 = new Date(Date.parse(night) - DAY).toISOString().slice(0, 10);
    const rows = byShow.get(s.id);
    // Same window as onTimeOutlets: the day before to the day after opening (a preview-period review is not a press-night find).
    const onTime = new Set(rows.filter((r) => /^\d{4}-\d{2}-\d{2}/.test(r.publishDate || '') && String(r.publishDate).slice(0, 10) <= plus1
      && String(r.publishDate).slice(0, 10) >= minus1).map((r) => r.outletId));
    const ids = [...new Set(rows.map((r) => r.outletId))];
    const cov = laneSourceCoverage(ids, s);
    const miss = cov.missing.map((id) => `${id}${onTime.has(id) ? ' (ON TIME)' : ''}`);
    onTimeMissing += cov.missing.filter((id) => onTime.has(id)).length;
    console.log(`${night}  ${s.id.padEnd(48)} ${String(ids.length).padStart(3)} outlets  ${String(Object.keys(cov.covered).length).padStart(3)} polled  ${String(Object.keys(cov.gaps).length).padStart(2)} gaps  ${String(cov.missing.length).padStart(2)} missing${miss.length ? `: ${miss.join(', ')}` : ''}`);
  }
  console.log(`\n${recent.length} openings, ${onTimeMissing} on-time outlet(s) with no lane source and no gap reason`);
  return onTimeMissing ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (e) { console.error(e.message); process.exitCode = 2; }
}
module.exports = { main, perShow };
