/**
 * Disk-backed cache for SERP query results. Thin wrapper around the generic
 * scripts/lib/ttl-cache.js (Scraping v2 Sprint 1 T5) — same behavior/env
 * vars as before generalization, existing consumers (url-discovery.js,
 * serp-slug-discovery.js) need no changes.
 *
 * Why: SERP is ~64% of the Bright Data bill ($193/mo on 128k calls). The same
 * "site:nytimes.com {show} review" query gets re-issued across orchestrator
 * iterations, gather-reviews runs, opening-night-poller dispatches, etc. The
 * answer doesn't change every 30 minutes — a 24h cache cuts duplicates with
 * zero reliability impact.
 *
 * Storage: /tmp/bd-serp-cache/{sha1}.json. In CI, persisted across runs via
 * actions/cache@v4 with the same path. Local dev: persists until /tmp clears.
 *
 * Cached: result arrays including empty arrays (no organic results IS a valid
 * answer). Not cached: nulls (provider failures — retry next time).
 */

const { createTtlCache } = require('./ttl-cache');

const CACHE_DIR = process.env.BD_SERP_CACHE_DIR || '/tmp/bd-serp-cache';
const TTL_HOURS = Number(process.env.BD_SERP_CACHE_TTL_HOURS || 24);
const DISABLED = process.env.BD_SERP_CACHE_DISABLED === '1';

const _cache = createTtlCache({ dir: CACHE_DIR, ttlMs: TTL_HOURS * 60 * 60 * 1000, disabled: DISABLED });

// Whitelist, not passthrough: any field NOT listed here is silently dropped
// from the cache key. `page` had to be added explicitly when the census
// started reading past page 1 (task #872) — without it, pages 2 and 3 of a
// paginated sweep hit page 1's cache entry and the deep-page arm degraded
// into three copies of the same ten URLs. Anything new that changes the
// RESULTS must be added here too.
function _normOpts(opts = {}) {
  return {
    geo: opts.geo || '',
    dateMin: opts.dateMin || '',
    dateMax: opts.dateMax || '',
    page: opts.page ? String(opts.page) : '',
  };
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
  _cache.logStats(log, 'SERP cache');
}

module.exports = { get, set, stats, logStats };
