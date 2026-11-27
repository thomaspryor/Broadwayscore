'use strict';
/**
 * Empty-answer SERP cache for gather-reviews' non-Broadway press-night passes
 * (BRO-8323; policy: gatherNegativeCacheTtlMs in serp-negative-cache-policy.js).
 *
 * Same get/set contract as serp-negative-cache.js (the poller's 45-min store),
 * but a 4h TTL and stored FLAT in serp-cache.js's directory under its own key
 * namespace (`neg: 'gather'`, a field serp-cache never puts in a key, so the two
 * can never answer for each other). Flat on purpose: gather-reviews.yml already
 * restores, uploads and merges /tmp/bd-serp-cache across runs and matrix shards
 * (its merge step copies files with a plain `cp`, which a subdirectory breaks),
 * so these entries survive from one 3h tick to the next with no workflow change.
 */
const { createTtlCache } = require('./ttl-cache');
const { GATHER_NEGATIVE_CACHE_TTL_MS } = require('./serp-negative-cache-policy');

const CACHE_DIR = process.env.BD_SERP_CACHE_DIR || '/tmp/bd-serp-cache';
const DISABLED = process.env.BD_SERP_CACHE_DISABLED === '1';

const _cache = createTtlCache({ dir: CACHE_DIR, ttlMs: GATHER_NEGATIVE_CACHE_TTL_MS, disabled: DISABLED });

// Mirrors serp-cache.js / serp-negative-cache.js _normOpts field for field (the
// same cacheOpts object reaches all three), plus the namespace tag.
function _normOpts(opts = {}) {
  return {
    geo: opts.geo || '',
    dateMin: opts.dateMin || '',
    dateMax: opts.dateMax || '',
    page: opts.page ? String(opts.page) : '',
    ...(opts.nosb ? { nosb: '1' } : {}),
    neg: 'gather',
  };
}

function get(query, opts = {}) { return _cache.get(query, _normOpts(opts)); }
function set(query, opts, value) { _cache.set(query, _normOpts(opts), value); }
function stats() { return _cache.stats(); }

module.exports = { get, set, stats, _normOpts, CACHE_DIR, TTL_MS: GATHER_NEGATIVE_CACHE_TTL_MS };
