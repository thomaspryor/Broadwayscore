'use strict';
/**
 * serp-query-cap.js — per-process cap on LIVE organic SERP queries, enforced at
 * the query boundary inside url-discovery.js (_serpWithChain). BRO-7171 Stage 2.
 *
 * Why at the boundary: discoverCorrectUrl() loops over alternate titles and
 * fallback queries, so one "discovery" can issue several paid queries. A
 * caller-side budget (count discoveries) cannot bound that; this one can.
 *
 * Env SERP_QUERY_BUDGET: a positive integer caps the live queries this process
 * may send. Unset, empty, 0, negative or non-numeric means NO cap (the default,
 * so every existing caller behaves exactly as before). Parsed strictly: "5abc"
 * is not a number and means no cap.
 *
 * Counted once per query that missed both caches, however many providers the
 * chain then tries (real spend can be up to the number of providers tried).
 * Per process: separate processes / shards do not share a count.
 * Not covered: serpNewsQuery / serpImagesQuery (they bypass _serpWithChain).
 */

function parseSerpQueryBudget(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/**
 * @param {number} used live queries already sent by this process
 * @param {string|undefined} raw env value
 * @returns {{allowed: boolean, budget: number|null}}
 */
function serpQueryBudgetAllows(used, raw) {
  const budget = parseSerpQueryBudget(raw);
  if (budget == null) return { allowed: true, budget: null };
  return { allowed: used < budget, budget };
}

module.exports = { parseSerpQueryBudget, serpQueryBudgetAllows };
