#!/usr/bin/env node
'use strict';
/**
 * UK regional review distribution (BRO-6713).
 *
 * Same show population as scripts/uk-regional-coverage.js and /browse/beyond-london:
 * category regional, at a uk-regional-venues.json house, not local-only.
 * Buckets each production by how many reviews it has (all reviews, and scored reviews
 * only), then breaks it down by city, opening year and review publish dates.
 *
 *   node scripts/uk-regional-distribution.js [--json] [--report=<file>]
 */
const path = require('path');
const { loadReviewsWithBlog } = require('./lib/load-reviews-with-blog');
const { hasHelpFlag } = require('./lib/cli-help');
const { isUkRegionalVenue } = require('./lib/market-label');
const { isLocalOnlyShow } = require('./lib/local-market');

const DATA = path.join(__dirname, '..', 'data');
const BUCKETS = [
  ['0', (n) => n === 0],
  ['1', (n) => n === 1],
  ['2', (n) => n === 2],
  ['3-4', (n) => n >= 3 && n <= 4],
  ['5-9', (n) => n >= 5 && n <= 9],
  ['10+', (n) => n >= 10],
];

function bucketOf(n) {
  return BUCKETS.find(([, f]) => f(n))[0];
}

function emptyBuckets() {
  return Object.fromEntries(BUCKETS.map(([k]) => [k, 0]));
}

function yearOf(d) {
  const m = typeof d === 'string' && /^(\d{4})/.exec(d);
  return m ? Number(m[1]) : null;
}

function distribution(shows, reviews) {
  const all = new Map();
  const scored = new Map();
  const dates = new Map();
  for (const r of reviews) {
    if (!r.showId) continue;
    all.set(r.showId, (all.get(r.showId) || 0) + 1);
    if (r.assignedScore != null) scored.set(r.showId, (scored.get(r.showId) || 0) + 1);
    const y = yearOf(r.publishDate || r.date);
    if (y) {
      if (!dates.has(r.showId)) dates.set(r.showId, []);
      dates.get(r.showId).push(r.publishDate || r.date);
    }
  }
  const pop = shows.filter((s) => s.category === 'regional' && isUkRegionalVenue(s.venue) && !isLocalOnlyShow(s));
  const out = {
    shows: pop.length,
    allBuckets: emptyBuckets(),
    scoredBuckets: emptyBuckets(),
    totalReviews: 0,
    totalScoredReviews: 0,
    cities: {},
    openingYears: {},
    reviewYears: {},
    status: {},
    earliestOpening: null,
    latestOpening: null,
    earliestReview: null,
    latestReview: null,
    zeroReviewShows: [],
  };
  for (const s of pop) {
    const n = all.get(s.id) || 0;
    const sc = scored.get(s.id) || 0;
    out.allBuckets[bucketOf(n)] += 1;
    out.scoredBuckets[bucketOf(sc)] += 1;
    out.totalReviews += n;
    out.totalScoredReviews += sc;
    const city = s.city || 'unknown';
    const c = (out.cities[city] ||= { shows: 0, reviews: 0, buckets: emptyBuckets() });
    c.shows += 1;
    c.reviews += n;
    c.buckets[bucketOf(n)] += 1;
    const oy = yearOf(s.openingDate) || 'unknown';
    out.openingYears[oy] = (out.openingYears[oy] || 0) + 1;
    out.status[s.status || 'unknown'] = (out.status[s.status || 'unknown'] || 0) + 1;
    if (s.openingDate) {
      if (!out.earliestOpening || s.openingDate < out.earliestOpening.date) out.earliestOpening = { id: s.id, date: s.openingDate };
      if (!out.latestOpening || s.openingDate > out.latestOpening.date) out.latestOpening = { id: s.id, date: s.openingDate };
    }
    for (const d of dates.get(s.id) || []) {
      const y = yearOf(d);
      out.reviewYears[y] = (out.reviewYears[y] || 0) + 1;
      if (!out.earliestReview || d < out.earliestReview.date) out.earliestReview = { id: s.id, date: d };
      if (!out.latestReview || d > out.latestReview.date) out.latestReview = { id: s.id, date: d };
    }
    // venue-write-guard-ok: report output only, never written to shows.json
    if (n === 0) out.zeroReviewShows.push({ id: s.id, city: s.city || null, venue: s.venue, openingDate: s.openingDate || null });
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/uk-regional-distribution.js [--json] [--report=<file>]');
    return 0;
  }
  const raw = require(path.join(DATA, 'shows.json'));
  const d = distribution(Array.isArray(raw) ? raw : raw.shows, loadReviewsWithBlog());
  const rep = (argv.find((a) => a.startsWith('--report=')) || '').split('=')[1];
  if (rep) require('fs').writeFileSync(rep, JSON.stringify(d, null, 2) + '\n');
  if (argv.includes('--json')) {
    console.log(JSON.stringify(d, null, 2));
    return 0;
  }
  const pct = (n) => (d.shows ? `${Math.round((1000 * n) / d.shows) / 10}%` : "n/a");
  console.log(`UK regional productions: ${d.shows}   reviews: ${d.totalReviews} (${d.totalScoredReviews} scored)`);
  console.log('\nReviews per show (all reviews)');
  for (const [k, n] of Object.entries(d.allBuckets)) console.log(`  ${k.padEnd(5)} ${String(n).padStart(4)}  ${pct(n)}`);
  console.log('\nReviews per show (scored reviews only)');
  for (const [k, n] of Object.entries(d.scoredBuckets)) console.log(`  ${k.padEnd(5)} ${String(n).padStart(4)}  ${pct(n)}`);
  console.log('\nBy city (shows | reviews | buckets 0,1,2,3-4,5-9,10+)');
  for (const [city, c] of Object.entries(d.cities).sort((a, b) => b[1].shows - a[1].shows)) {
    console.log(`  ${city.padEnd(22)} ${String(c.shows).padStart(4)} | ${String(c.reviews).padStart(5)} | ${Object.values(c.buckets).map((x) => String(x).padStart(3)).join(' ')}`);
  }
  console.log('\nOpening year (shows)');
  console.log('  ' + Object.entries(d.openingYears).sort().map(([y, n]) => `${y}:${n}`).join('  '));
  console.log('\nReview publish year (reviews)');
  console.log('  ' + Object.entries(d.reviewYears).sort().map(([y, n]) => `${y}:${n}`).join('  '));
  console.log(`\nEarliest opening: ${JSON.stringify(d.earliestOpening)}  Latest: ${JSON.stringify(d.latestOpening)}`);
  console.log(`Earliest review:  ${JSON.stringify(d.earliestReview)}  Latest: ${JSON.stringify(d.latestReview)}`);
  console.log(`Status: ${JSON.stringify(d.status)}`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { distribution, bucketOf };
