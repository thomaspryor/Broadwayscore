#!/usr/bin/env node
/**
 * predict-review-count.js
 *
 * Predicts expected final review count for a show.
 *
 * Method (no ML): historical median of comparable shows from the last 24
 * months, grouped by (market, type, isRevival). Cohorts smaller than 5 fall
 * back to (market, isRevival), then to (market, isRevival) regardless of
 * type, then return null.
 *
 * Caveat: this is a cohort lookup, not a trained model. It can't tell a
 * proper opening from a filler revue with the same shape (e.g. Celebrity
 * Autobiography is type='play', isRevival=true → cohort median is 28, but
 * it's a variety show and critics don't cover it). Exclude such shows by
 * adding their ids to data/digest-excluded-shows.json — the wrapper that
 * consumes predictReviewCount() reads that list and shows TBD instead.
 *
 * Usage:
 *   node scripts/predict-review-count.js                    # Print cohort table
 *   node scripts/predict-review-count.js --show=SHOW_ID     # Print single prediction
 *
 * As a module:
 *   const { predictReviewCount, getCohortStats } = require('./predict-review-count');
 *   predictReviewCount({ market: 'broadway', type: 'play', isRevival: false })
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

function cohortKey({ market, type, isRevival }) {
  if (type) return `${market}:${type}:${isRevival ? 'revival' : 'original'}`;
  return `${market}:${isRevival ? 'revival' : 'original'}`;
}

function getType(show) {
  return show.type || 'play';
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

  // Build both fine-grained (market, type, revival) and coarse (market, revival) cohorts
  const cohorts = {};
  for (const [id, n] of counts) {
    const sh = showById.get(id);
    if (!sh || !sh.openingDate) continue;
    const ageDays = (Date.now() - new Date(sh.openingDate).getTime()) / 86400000;
    if (ageDays < 0 || ageDays > LOOKBACK_DAYS) continue;
    if (sh.status === 'upcoming') continue;
    const market = getMarket(sh);
    const type = getType(sh);
    const isRev = sh.isRevival === true;
    const fine = cohortKey({ market, type, isRevival: isRev });
    const coarse = cohortKey({ market, isRevival: isRev });
    (cohorts[fine] = cohorts[fine] || []).push(n);
    (cohorts[coarse] = cohorts[coarse] || []).push(n);
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
  const type = input.type || (input.type === null ? null : getType(input));
  const isRevival = input.isRevival === true;
  const stats = getStatsCached();

  // 1) (market, type, isRevival) — most specific
  const fineKey = cohortKey({ market, type, isRevival });
  const fine = stats[fineKey];
  if (fine && fine.n >= 5) {
    return { expected: fine.median, p25: fine.p25, p75: fine.p75, cohort: fineKey, n: fine.n };
  }
  // 2) (market, isRevival) — drop type
  const coarseKey = cohortKey({ market, isRevival });
  const coarse = stats[coarseKey];
  if (coarse && coarse.n >= 5) {
    return { expected: coarse.median, p25: coarse.p25, p75: coarse.p75, cohort: coarseKey + ' (type fallback)', n: coarse.n };
  }
  // 3) (market, opposite revival) — drop revival distinction
  const altKey = cohortKey({ market, isRevival: !isRevival });
  const alt = stats[altKey];
  if (alt && alt.n >= 5) {
    return { expected: alt.median, p25: alt.p25, p75: alt.p75, cohort: altKey + ' (revival fallback)', n: alt.n };
  }
  // 4) Use whatever we have, even if thin
  if (fine && fine.n > 0) return { expected: fine.median, p25: fine.p25, p75: fine.p75, cohort: fineKey, n: fine.n };
  if (coarse && coarse.n > 0) return { expected: coarse.median, p25: coarse.p25, p75: coarse.p75, cohort: coarseKey, n: coarse.n };
  return { expected: null, p25: null, p75: null, cohort: fineKey, n: 0 };
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
    console.log(`${sh.title} (${getMarket(sh)}, ${getType(sh)}, ${sh.isRevival ? 'revival' : 'original'})`);
    console.log(`Expected reviews: ${p.expected} (p25=${p.p25}, p75=${p.p75}, cohort=${p.cohort}, n=${p.n})`);
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
