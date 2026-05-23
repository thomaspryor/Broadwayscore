#!/usr/bin/env node
/**
 * predict-review-count.js
 *
 * Predicts expected final review count for a show, based on historical median
 * of comparable shows from the last 24 months grouped by (market, isRevival).
 *
 * Usage:
 *   node scripts/predict-review-count.js                    # Print cohort table
 *   node scripts/predict-review-count.js --show=SHOW_ID     # Print single prediction
 *
 * As a module:
 *   const { predictReviewCount, getCohortStats } = require('./predict-review-count');
 *   predictReviewCount({ market: 'broadway', isRevival: false }) // { median, p25, p75, n }
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const REVIEWS_PATH = path.join(DATA_DIR, 'reviews.json');

const LOOKBACK_DAYS = 730; // 24 months

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const rank = (sortedArr.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedArr[lo];
  const frac = rank - lo;
  return Math.round(sortedArr[lo] * (1 - frac) + sortedArr[hi] * frac);
}

function getMarket(show) {
  return show.category || show.market || 'broadway';
}

function cohortKey({ market, isRevival }) {
  return `${market}:${isRevival ? 'revival' : 'original'}`;
}

/**
 * Build cohort stats from shows.json + reviews.json.
 * Returns { 'broadway:original': { n, p25, median, p75 }, ... }
 */
function getCohortStats() {
  const shows = loadJSON(SHOWS_PATH);
  const reviews = loadJSON(REVIEWS_PATH);
  const showById = new Map((shows.shows || shows).map(x => [x.id, x]));
  const reviewList = reviews.reviews || reviews;

  const counts = new Map();
  for (const rv of reviewList) {
    if (!rv.showId) continue;
    counts.set(rv.showId, (counts.get(rv.showId) || 0) + 1);
  }

  const cohorts = {};
  for (const [id, n] of counts) {
    const sh = showById.get(id);
    if (!sh || !sh.openingDate) continue;
    const ageDays = (Date.now() - new Date(sh.openingDate).getTime()) / 86400000;
    if (ageDays < 0 || ageDays > LOOKBACK_DAYS) continue;
    if (sh.status === 'upcoming') continue;
    const key = cohortKey({ market: getMarket(sh), isRevival: sh.isRevival === true });
    (cohorts[key] = cohorts[key] || []).push(n);
  }

  const stats = {};
  for (const [k, arr] of Object.entries(cohorts)) {
    const sorted = [...arr].sort((a, b) => a - b);
    stats[k] = {
      n: sorted.length,
      p25: percentile(sorted, 0.25),
      median: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
    };
  }
  return stats;
}

let _cachedStats = null;
function getStatsCached() {
  if (!_cachedStats) _cachedStats = getCohortStats();
  return _cachedStats;
}

/**
 * Predict expected review count for a show.
 * Input: { market, isRevival } OR a full show object.
 * Returns { expected, p25, p75, cohort, n } or { expected: null, cohort, n: 0 }
 * if the cohort has no historical data.
 */
function predictReviewCount(input) {
  const market = input.market || getMarket(input);
  const isRevival = input.isRevival === true;
  const stats = getStatsCached();
  const primaryKey = cohortKey({ market, isRevival });
  const primary = stats[primaryKey];
  if (primary && primary.n >= 5) {
    return { expected: primary.median, p25: primary.p25, p75: primary.p75, cohort: primaryKey, n: primary.n };
  }
  // Fallback: same market, opposite revival flag
  const altKey = cohortKey({ market, isRevival: !isRevival });
  const alt = stats[altKey];
  if (alt && alt.n >= 5) {
    return { expected: alt.median, p25: alt.p25, p75: alt.p75, cohort: altKey + ' (fallback)', n: alt.n };
  }
  if (primary && primary.n > 0) {
    return { expected: primary.median, p25: primary.p25, p75: primary.p75, cohort: primaryKey, n: primary.n };
  }
  return { expected: null, p25: null, p75: null, cohort: primaryKey, n: 0 };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const showArg = args.find(a => a.startsWith('--show='));
  if (showArg) {
    const id = showArg.split('=')[1];
    const shows = loadJSON(SHOWS_PATH);
    const sh = (shows.shows || shows).find(s => s.id === id);
    if (!sh) {
      console.error(`Show not found: ${id}`);
      process.exit(1);
    }
    const p = predictReviewCount(sh);
    console.log(`${sh.title} (${getMarket(sh)}, ${sh.isRevival ? 'revival' : 'original'})`);
    console.log(`Expected reviews: ${p.expected} (p25=${p.p25}, p75=${p.p75}, cohort n=${p.n})`);
  } else {
    const stats = getCohortStats();
    console.log('Cohort: (market, original/revival)');
    console.log('Source: shows opened in last 24 months');
    console.log('');
    for (const [k, c] of Object.entries(stats).sort()) {
      console.log(`${k.padEnd(28)} n=${String(c.n).padStart(3)}  p25=${String(c.p25).padStart(3)}  median=${String(c.median).padStart(3)}  p75=${String(c.p75).padStart(3)}`);
    }
  }
}

module.exports = { predictReviewCount, getCohortStats };
