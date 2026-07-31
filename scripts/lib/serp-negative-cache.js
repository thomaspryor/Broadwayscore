/**
 * Disk-backed cache for SERP NEGATIVE (empty) results, on a short 45-min TTL —
 * separate from serp-cache.js's 24h positive cache (Scraping v2 Sprint 1 T11).
 *
 * Why a separate cache: _serpWithChain's normal 24h cache never stores empty
 * results for emptyAuthoritative:false callers (opening-night-poller.js) — an
 * empty SERP there commonly means "hasn't published yet," not a stable answer,
 * so caching it for 24h would hide a review published minutes later. This
 * cache exists for the narrower, opt-in case (see serp-negative-cache-policy.js):
 * OB/WE shows in the poller's SERP backup layer, where a 45-min window cuts
 * repeat BD/SB spend across consecutive poll ticks without meaningfully
 * delaying discovery. Broadway never opts in — see that file for why.
 *
 * Storage: /tmp/bd-serp-negative-cache/{sha1}.json — same actions/cache@v4
 * persistence pattern as serp-cache.js, distinct directory so a 24h positive
 * cache restore doesn't clobber this or vice versa.
 */

const { createTtlCache } = require('./ttl-cache');
const { NEGATIVE_CACHE_TTL_MS } = require('./serp-negative-cache-policy');

const CACHE_DIR = process.env.BD_SERP_NEGATIVE_CACHE_DIR || '/tmp/bd-serp-negative-cache';
const DISABLED = process.env.BD_SERP_CACHE_DISABLED === '1';

const _cache = createTtlCache({ dir: CACHE_DIR, ttlMs: NEGATIVE_CACHE_TTL_MS, disabled: DISABLED });

function _normOpts(opts = {}) {
  return { geo: opts.geo || '', dateMin: opts.dateMin || '', dateMax: opts.dateMax || '' };
}

function get(query, opts = {}) {
  return _cache.get(query, _normOpts(opts));
}

function set(query, opts, value) {
  _cache.set(query, _normOpts(opts), value);
}

function stats() {
  return _cache.stats();
}

function logStats(log = console.log) {
  _cache.logStats(log, 'SERP negative cache');
}

module.exports = { get, set, stats, logStats };
