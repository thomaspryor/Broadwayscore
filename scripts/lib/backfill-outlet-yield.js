'use strict';
/**
 * Backfill outlet pruning (BRO-6490).
 *
 * Bulk historical-backfill gather runs search up to 150 outlets per show,
 * about one Scrapingdog query each. Most outlets never reviewed a show in
 * that market. Log sample (3 runs, 20 West End 2012-13 + 9 Off-Broadway 2022
 * shows, 3,850 searches, 55 hits): skipping outlets with fewer than 3 past
 * reviews in the show's market pool cut West End searches 48% and
 * Off-Broadway 37%, and lost 1 hit (a blog with no London history).
 *
 * Only bulk backfill dispatches prune (spend purpose mentions "historical":
 * historical-backfill.yml's `historical-backfill`, session tags like
 * `bro-6453-we-historical`). Current shows and targeted recoveries keep the
 * full sweep, so outlet history keeps growing. Every failure path (no
 * reviews.json, unknown market, threshold 0) disables pruning, never the
 * reverse: an empty count table must not skip every outlet.
 */
const fs = require('fs');
const { getMarketPool } = require('./venue-classification');

const DEFAULT_MIN_REVIEWS = 3;
const POOLED_CATEGORIES = new Set(['broadway', 'off-broadway', 'west-end', 'off-west-end']);

function isBulkBackfillPurpose(purpose) {
  return /historical/i.test(String(purpose || ''));
}

/** SERP_BACKFILL_MIN_OUTLET_REVIEWS: non-negative integer, 0 disables. */
function resolveMinReviews(env = process.env) {
  const n = parseInt(env.SERP_BACKFILL_MIN_OUTLET_REVIEWS, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_REVIEWS;
}

/** 'london' | 'nyc' for the four pooled categories, else null (never pruned). */
function marketPoolForCategory(category) {
  return POOLED_CATEGORIES.has(category) ? getMarketPool(category) : null;
}

/**
 * Count reviews per outlet per market pool.
 * @param {Array<{showId: string, outletId?: string}>} reviews
 * @param {(showId: string) => string|null} poolOfShow
 * @returns {Map<string, Map<string, number>>} pool -> lowercased outletId -> count
 */
function buildOutletPoolCounts(reviews, poolOfShow) {
  const counts = new Map();
  for (const r of reviews || []) {
    const id = String((r && r.outletId) || '').toLowerCase();
    if (!id) continue;
    const pool = poolOfShow(r.showId);
    if (!pool) continue;
    if (!counts.has(pool)) counts.set(pool, new Map());
    const m = counts.get(pool);
    m.set(id, (m.get(id) || 0) + 1);
  }
  return counts;
}

/**
 * @returns {{skip: boolean, count: number|null, minReviews: number}}
 */
function backfillOutletDecision({ outletId, pool, counts, minReviews }) {
  const poolCounts = counts && pool ? counts.get(pool) : null;
  if (!minReviews || !poolCounts || poolCounts.size === 0) {
    return { skip: false, count: null, minReviews };
  }
  const count = poolCounts.get(String(outletId || '').toLowerCase()) || 0;
  return { skip: count < minReviews, count, minReviews };
}

/** Reads reviews.json once; null (pruning off) when it can't be read. */
function loadOutletPoolCounts(reviewsPath, categoryOfShow) {
  try {
    const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
    const reviews = Array.isArray(data) ? data : data.reviews;
    if (!Array.isArray(reviews) || reviews.length === 0) return null;
    return buildOutletPoolCounts(reviews, (id) => marketPoolForCategory(categoryOfShow(id)));
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_MIN_REVIEWS,
  isBulkBackfillPurpose,
  resolveMinReviews,
  marketPoolForCategory,
  buildOutletPoolCounts,
  backfillOutletDecision,
  loadOutletPoolCounts,
};
