'use strict';
/**
 * gap-strategy-table.js — which recovery strategy the gap-recovery driver tries
 * for each gap class, in cost order (zero-gap plan §2.2, revised plan Stage 2).
 * Pure: the caller injects eligibility.
 *
 * STRATEGY_FLAGS is the config switch the Stage 2 decision rule flips: if the
 * NO_URL pilot accepts <30% through URL rediscovery, URL_REDISCOVER and AGG_LINK
 * are set enabled:false here and the driver stops planning them.
 */

const STRATEGY_FLAGS = Object.freeze({
  REFETCH_FREE: Object.freeze({ enabled: true, cost: 'F', note: 'fetchPage free tiers only (cookies-plain, playwright)' }),
  BROWSER_SESSION: Object.freeze({ enabled: true, cost: 'B', note: 'headed subscriber Chrome via browser-outlet-adapters' }),
  ARCHIVE: Object.freeze({ enabled: true, cost: 'F', note: 'earliest 200 Wayback capture (pre-paywall)' }),
  URL_REDISCOVER: Object.freeze({ enabled: true, cost: 'S', note: 'discoverCorrectUrl + identity proof; search budget enforced in url-discovery' }),
  AGG_LINK: Object.freeze({ enabled: false, cost: 'F', note: 'unbuilt: aggregator outbound links unverified (revised plan item 1)' }),
});

// Order per class. FALSE_TRUNCATION_SUSPECT is fixed by the classifier at the
// next rebuild; UNCLASSIFIED has no route.
const CLASS_STRATEGIES = Object.freeze({
  SHORT_UNVERIFIED: ['REFETCH_FREE', 'BROWSER_SESSION', 'ARCHIVE'],
  TRUNCATED_OTHER: ['REFETCH_FREE', 'BROWSER_SESSION', 'ARCHIVE'],
  PAYWALL_TRUNCATED: ['BROWSER_SESSION', 'ARCHIVE'],
  PAYWALL_PAGE: ['BROWSER_SESSION', 'ARCHIVE'],
  NEVER_FETCHED: ['REFETCH_FREE', 'BROWSER_SESSION', 'ARCHIVE'],
  BLOCKED: ['REFETCH_FREE', 'BROWSER_SESSION', 'ARCHIVE'],
  DEFERRED: ['REFETCH_FREE', 'BROWSER_SESSION', 'ARCHIVE'],
  GARBAGE_PAGE: ['REFETCH_FREE', 'BROWSER_SESSION', 'ARCHIVE', 'URL_REDISCOVER'],
  URL_DEAD: ['ARCHIVE', 'URL_REDISCOVER'],
  URL_WRONG_PAGE: ['URL_REDISCOVER'],
  NO_URL: ['AGG_LINK', 'URL_REDISCOVER'],
  FALSE_TRUNCATION_SUSPECT: [],
  UNCLASSIFIED: [],
});

const URL_STRATEGIES = new Set(['REFETCH_FREE', 'BROWSER_SESSION', 'ARCHIVE']);

/**
 * Pick the first usable strategy for one candidate.
 * @param {object} a
 * @param {string} a.gapClass
 * @param {boolean} a.hasUrl
 * @param {boolean} a.hasAdapter     a browser adapter exists for the outlet
 * @param {(strategy:string) => {ok:boolean, reason:string}} [a.eligible] ledger/file gates
 * @param {Record<string, {ok:boolean, reason:string}>} [a.runGates] run-level gates, e.g.
 *        {BROWSER_SESSION: {ok:false, reason:'browser_unavailable'}, URL_REDISCOVER: {ok:false, reason:'no_serp_key'}}
 * @param {object} [a.flags] STRATEGY_FLAGS override (tests)
 * @param {string|null} [a.only] restrict to one strategy
 * @returns {{strategy: string|null, skipped: Array<{strategy:string, reason:string}>}}
 */
function selectStrategy({ gapClass, hasUrl, hasAdapter, eligible = () => ({ ok: true, reason: 'not_gated' }), runGates = {}, flags = STRATEGY_FLAGS, only = null }) {
  const order = CLASS_STRATEGIES[gapClass] || [];
  const skipped = [];
  for (const s of order) {
    if (only && s !== only) continue;
    const f = flags[s];
    if (!f || !f.enabled) { skipped.push({ strategy: s, reason: 'disabled' }); continue; }
    if (URL_STRATEGIES.has(s) && !hasUrl) { skipped.push({ strategy: s, reason: 'no_url' }); continue; }
    if (s === 'BROWSER_SESSION' && !hasAdapter) { skipped.push({ strategy: s, reason: 'no_adapter' }); continue; }
    const g = runGates[s];
    if (g && !g.ok) { skipped.push({ strategy: s, reason: g.reason }); continue; }
    const e = eligible(s);
    if (!e.ok) { skipped.push({ strategy: s, reason: e.reason }); continue; }
    return { strategy: s, skipped };
  }
  return { strategy: null, skipped };
}

const ms = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };

/**
 * Candidate order: recent shows (<=2y) first, then newest show first, then
 * cheapest planned strategy first, then a stable key.
 */
function compareCandidates(a, b) {
  if ((a.recency === 'recent') !== (b.recency === 'recent')) return a.recency === 'recent' ? -1 : 1;
  const da = ms(a.showDate); const db = ms(b.showDate);
  if (da !== db) return db - da;
  const cost = { F: 0, B: 1, S: 2 };
  const ca = a.strategy ? cost[STRATEGY_FLAGS[a.strategy].cost] : 9;
  const cb = b.strategy ? cost[STRATEGY_FLAGS[b.strategy].cost] : 9;
  if (ca !== cb) return ca - cb;
  return String(a.reviewKey).localeCompare(String(b.reviewKey));
}

module.exports = { STRATEGY_FLAGS, CLASS_STRATEGIES, selectStrategy, compareCandidates };
