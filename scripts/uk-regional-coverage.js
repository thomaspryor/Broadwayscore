#!/usr/bin/env node
'use strict';
/**
 * BRO-6541: how much of /browse/beyond-london shows a score, per city.
 *
 * A UK regional production (the rows /browse/beyond-london lists: category regional at a
 * uk-regional-venues.json house, not local-only, as src/lib/data-core.ts getUkRegionalShows) is scoreable when the
 * site would display its critic score: computeCriticScore over its scored reviews, then
 * hasEnoughReviews (scripts/lib/min-reviews.js), the same gate as the show page badge.
 *
 *   node scripts/uk-regional-coverage.js [--json] [--min-share=0.6] [--min-shows=450]
 * Exit 1 when a --min-* target is missed (test.yml runs it advisory), else 0.
 */
const path = require('path');
const { hasEnoughReviews } = require('./lib/min-reviews');
const { computeCriticScore } = require('./lib/compute-critic-score');
const { loadReviewsWithBlog } = require('./lib/load-reviews-with-blog');
const { hasHelpFlag } = require('./lib/cli-help');
const { isUkRegionalVenue } = require('./lib/market-label');
const { isLocalOnlyShow } = require('./lib/local-market');

const DATA = path.join(__dirname, '..', 'data');

function coverage(shows, reviews, outletRegistry) {
  const byShow = new Map();
  for (const r of reviews) {
    if (!r.showId || r.assignedScore == null) continue;
    if (!byShow.has(r.showId)) byShow.set(r.showId, []);
    byShow.get(r.showId).push(r);
  }
  const cities = {};
  for (const s of shows) {
    if (s.category !== 'regional' || !isUkRegionalVenue(s.venue) || isLocalOnlyShow(s)) continue;
    const c = (cities[s.city || 'unknown'] ||= { shows: 0, reviews: 0, scoreable: 0 });
    const revs = byShow.get(s.id) || [];
    c.shows += 1;
    c.reviews += revs.length;
    const res = revs.length ? computeCriticScore(revs, outletRegistry, s.category, s.type) : null;
    if (res && hasEnoughReviews(res.rc, s.category, res.t1 + res.t2)) c.scoreable += 1;
  }
  const total = Object.values(cities).reduce((a, c) => ({ shows: a.shows + c.shows, reviews: a.reviews + c.reviews, scoreable: a.scoreable + c.scoreable }), { shows: 0, reviews: 0, scoreable: 0 });
  return { cities, total };
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/uk-regional-coverage.js [--json] [--min-share=0.6] [--min-shows=450]');
    return 0;
  }
  const arg = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
  const raw = require(path.join(DATA, 'shows.json'));
  const reg = require(path.join(DATA, 'outlet-registry.json'));
  const { cities, total } = coverage(Array.isArray(raw) ? raw : raw.shows, loadReviewsWithBlog(), reg.outlets || reg);
  const share = total.shows ? total.scoreable / total.shows : 0;
  if (argv.includes('--json')) console.log(JSON.stringify({ cities, total, share }, null, 2));
  else {
    for (const [city, c] of Object.entries(cities).sort((a, b) => b[1].shows - a[1].shows)) {
      console.log(`${city.padEnd(24)} shows ${String(c.shows).padStart(4)}  reviews ${String(c.reviews).padStart(5)}  scoreable ${String(c.scoreable).padStart(4)} (${Math.round((100 * c.scoreable) / c.shows)}%)`);
    }
    console.log(`${'TOTAL'.padEnd(24)} shows ${String(total.shows).padStart(4)}  reviews ${String(total.reviews).padStart(5)}  scoreable ${String(total.scoreable).padStart(4)} (${Math.round(100 * share)}%)`);
  }
  const misses = [];
  if (arg('min-shows') && total.shows < Number(arg('min-shows'))) misses.push(`${total.shows} UK regional productions < ${arg('min-shows')}`);
  if (arg('min-share') && share < Number(arg('min-share'))) misses.push(`${Math.round(100 * share)}% scoreable < ${Math.round(100 * Number(arg('min-share')))}%`);
  for (const m of misses) console.log(`::warning::UK regional coverage: ${m}`);
  return misses.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { coverage };
