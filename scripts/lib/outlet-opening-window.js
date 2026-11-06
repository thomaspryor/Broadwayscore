'use strict';
/**
 * Opening-window mode for scripts/outlet-listing-poller.js (BRO-7051).
 *
 * The daily poller found a Theater Pizzazz review 18h late because it runs once a day.
 * Opening-window mode runs every 3h but only for shows 0-3 days past opening, only for
 * outlets that review those shows' markets, and only through free feeds / listing pages.
 * No SERP, and paid page fetches are capped per run.
 *
 * Pure functions only (no I/O) so tests require() the real filters.
 */

const WINDOW_DAYS_PAST = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
// Markets with a press night. Tours and regional stops have none (BRO-4724).
const WINDOW_CATEGORIES = new Set(['broadway', 'off-broadway', 'west-end', 'off-west-end']);
const WINDOW_STRATEGIES = new Set(['rss', 'sitemap', 'listing-html', 'wp-api']);
const DEFAULT_MAX_PAID = 15;
// Worst-case price per paid fetch (Bright Data unlocker, ~$1.50/1k; Scrapingdog is 5-15x cheaper).
const WORST_CASE_USD_PER_PAID_CALL = 0.0015;

function utcDay(d) {
  const t = Date.parse(d);
  return Number.isFinite(t) ? Math.floor(t / DAY_MS) : null;
}

/** Shows whose openingDate is 0..maxDaysPast UTC days ago (status-independent: a press night
 *  can pass while status is still "previews" or "upcoming"). */
function selectWindowShows(allShows, now = Date.now(), { maxDaysPast = WINDOW_DAYS_PAST } = {}) {
  const today = Math.floor(now / DAY_MS);
  return allShows.filter((s) => {
    if (!WINDOW_CATEGORIES.has(s.category)) return false;
    const d = utcDay(s.openingDate);
    return d !== null && today - d >= 0 && today - d <= maxDaysPast;
  });
}

/** How an outlet is polled in window mode: its configured strategy, or null (skip: SERP-only). */
function windowStrategyFor(outletId, outletStrategyConfig, wpApiConfig) {
  if (wpApiConfig[outletId]) return 'wp-api';
  const sc = outletStrategyConfig[outletId];
  return sc && WINDOW_STRATEGIES.has(sc.strategy) ? sc.strategy : null;
}

/**
 * Outlets to poll: free-strategy outlets with >= minShowCount distinct reviewed shows, in the
 * last lookbackDays, in the same market(s) as the window shows. Returns {outlets, skippedSerp}.
 */
function selectWindowOutlets({ windowShows, allShows, allReviews, outletStrategyConfig, wpApiConfig, skipOutlets, now = Date.now(), minShowCount = 2, lookbackDays = 120 }) {
  const markets = new Set(windowShows.map((s) => s.category));
  if (markets.size === 0) return { outlets: [], skippedSerp: [] };
  const cutoff = now - lookbackDays * DAY_MS;
  const recent = new Set();
  for (const s of allShows) {
    if (!markets.has(s.category)) continue;
    const t = Date.parse(s.openingDate || s.previewsStartDate || '');
    if (Number.isFinite(t) && t >= cutoff) recent.add(s.id);
  }
  const perOutlet = {};
  for (const r of allReviews) {
    if (!r.outletId || skipOutlets.has(r.outletId) || !recent.has(r.showId)) continue;
    (perOutlet[r.outletId] = perOutlet[r.outletId] || new Set()).add(r.showId);
  }
  const outlets = [];
  const skippedSerp = [];
  const configured = new Set([...Object.keys(outletStrategyConfig), ...Object.keys(wpApiConfig)]);
  for (const [id, set] of Object.entries(perOutlet).sort((a, b) => b[1].size - a[1].size)) {
    if (set.size < minShowCount) continue;
    if (windowStrategyFor(id, outletStrategyConfig, wpApiConfig)) outlets.push(id);
    else skippedSerp.push(id);
  }
  // Configured free-strategy outlets with a small count still count when they reviewed this market at all.
  for (const id of configured) {
    if (outlets.includes(id) || skipOutlets.has(id) || !perOutlet[id]) continue;
    if (windowStrategyFor(id, outletStrategyConfig, wpApiConfig)) outlets.push(id);
  }
  return { outlets, skippedSerp };
}

/** Paid-fetch budget shared by every paid call in a run. attempt() is true while budget remains. */
function createPaidBudget(max = DEFAULT_MAX_PAID) {
  const b = { max, used: 0, refused: 0 };
  b.attempt = () => {
    if (b.used >= b.max) { b.refused++; return false; }
    b.used++;
    return true;
  };
  return b;
}

/** Projected monthly worst-case spend. activeRunsPerMonth = 3h runs that have in-window shows. */
function projectMonthlyCost({ paidPerRun, activeRunsPerMonth, usdPerCall = WORST_CASE_USD_PER_PAID_CALL }) {
  const calls = paidPerRun * activeRunsPerMonth;
  return { calls, usd: Math.round(calls * usdPerCall * 100) / 100 };
}

/** A review-text record that still needs its text collected (mirrors collect-we-ob-reviews' remaining count). */
function needsCollection(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.assignedScore || r.duplicateOf || r.wrongShow || r.wrongProduction || r.wrongAttribution
      || r.contentTier === 'invalid' || r.isRoundupArticle || r.rejectionReason) return false;
  const hasText = r.fullText || r.bwwExcerpt || r.dtliExcerpt || r.showScoreExcerpt || r.nycTheatreExcerpt || r.lboRoundupExcerpt;
  return !hasText && typeof r.url === 'string' && r.url.startsWith('http');
}

/** Window show ids with uncollected records, most pending first, at most `limit`. recordsByShow: {showId: [record]} */
function showsNeedingCollection(windowShows, recordsByShow, limit = 3) {
  return windowShows
    .map((s) => ({ id: s.id, n: (recordsByShow[s.id] || []).filter(needsCollection).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((x) => x.id);
}

module.exports = {
  needsCollection, showsNeedingCollection,
  WINDOW_DAYS_PAST, WINDOW_CATEGORIES, WINDOW_STRATEGIES, DEFAULT_MAX_PAID, WORST_CASE_USD_PER_PAID_CALL,
  selectWindowShows, windowStrategyFor, selectWindowOutlets, createPaidBudget, projectMonthlyCost,
};
