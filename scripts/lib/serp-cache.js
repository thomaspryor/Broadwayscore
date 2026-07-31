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
  _cache.logStats(log, 'SERP cache');
}

module.exports = { get, set, stats, logStats };
