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
  // Stage 3 live pilots 2026-11-09 (30% bar applied per recency band):
  // recent shows 0/20 accepted (17 archive_empty: Wayback has no capture of a
  // review this new; 3 not_longer) -> OFF for recent shows; historic shows
  // (--historic-only) 9/20 = 45% accepted -> stays ON for historic shows.
  ARCHIVE: Object.freeze({ enabled: true, historicOnly: true, cost: 'F', note: 'earliest non-teaser 200 Wayback capture (pre-paywall); historic shows only' }),
  // DISABLED 2026-11-09 by the Stage 2 decision rule: the NO_URL pilot (20
  // daily-mail / mail-on-sunday files) accepted 0/20, and The Stage
  // URL_WRONG_PAGE run 0/14, all no_serp_match. Part of that is a provider
  // defect, not an absence of articles: Scrapingdog now returns many organic
  // `link`s as opaque google.com/url?q=CAES... tokens (no target url inside;
  // the redirect answers 200, not a 302), which url-discovery blocks as
  // non-review hosts. Re-measure after that is fixed before turning this on.
  // RE-MEASURED 2026-11-09 after the opaque-link fix (BRO-7171 Stage 2b, same 20
  // Mail files, empty SERP cache): 35 opaque links seen, 18 recovered, 17
  // dropped, 0 reached the matcher; still 1 candidate / 0 fetched / 0 accepted,
  // under the 30% bar, so this stays off. The Mail pool is proven-zero for
  // another reason (serp-text-recovery-candidates.js: not indexed as reviews).
  URL_REDISCOVER: Object.freeze({ enabled: false, cost: 'S', note: 'discoverCorrectUrl + identity proof; search budget enforced in url-discovery' }),
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
function selectStrategy({ gapClass, hasUrl, hasAdapter, recency = null, eligible = () => ({ ok: true, reason: 'not_gated' }), runGates = {}, flags = STRATEGY_FLAGS, only = null }) {
  const order = CLASS_STRATEGIES[gapClass] || [];
  const skipped = [];
  for (const s of order) {
    if (only && s !== only) continue;
    const f = flags[s];
    if (!f || !f.enabled) { skipped.push({ strategy: s, reason: 'disabled' }); continue; }
    if (f.historicOnly && recency === 'recent') { skipped.push({ strategy: s, reason: 'disabled_recent' }); continue; }
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

/**
 * Live-run preflight. The acceptance gate's generic-title check reads the
 * repo's own data/shows.json and turns itself off (with only a warning) when
 * it is missing, and the cookie loader reads the repo's own data/cookies/.
 * A git worktree has neither (both are gitignored), so a live run from a
 * worktree would accept texts with a weaker gate and burn every subscriber
 * candidate on `no_cookies`. Found in the BRO-7171 Stage 2 pilot.
 * @param {{showsJsonReadable:boolean, cookieJarExists:boolean}} env
 * @returns {{fatal:string|null, runGates:object}}
 */
function liveEnvironmentGates({ showsJsonReadable, cookieJarExists }) {
  const runGates = {};
  if (!cookieJarExists) runGates.BROWSER_SESSION = { ok: false, reason: 'browser_unavailable:cookie_jar_missing' };
  const fatal = showsJsonReadable ? null
    : 'data/shows.json is not readable from this checkout, so the generic-title gate would be off; run from the main checkout or link data/shows.json';
  return { fatal, runGates };
}

module.exports = { STRATEGY_FLAGS, CLASS_STRATEGIES, selectStrategy, compareCandidates, liveEnvironmentGates };
