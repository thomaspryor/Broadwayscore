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
 * Storage: /tmp/bd-serp-cache/{sha1}.json. Local dev: persists until /tmp
 * clears. In CI, gather-reviews.yml and opening-night-poller.yml carry it
 * across runs with actions/cache (restore-keys prefix bd-serp-cache-; the
 * poller caches a different path set, so the two chains never share entries).
 * gather-reviews' merge-serp-cache job folds every matrix shard into one entry
 * and drops files past the TTL (BRO-4146); get() alone never deletes them.
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

// BRO-4146: per-process miss/write report for CI diagnosis. Repeated shows
// were re-paying full SERP cost with a restored cache, and gather job logs are
// too long to read the per-query "SERP cache hit" lines. When
// SERP_CACHE_REPORT_DIR is set, the process writes a small JSON summary there
// on exit (hits, misses, writes, the most-missed queries, and how many misses
// were queries this same process had already written).
const REPORT_DIR = process.env.SERP_CACHE_REPORT_DIR || '';
const _missCounts = new Map();
const _written = new Set();
let _missAfterWrite = 0;
const _reportKey = (query, opts) => JSON.stringify([String(query || '').trim().toLowerCase(), _normOpts(opts)]);

function get(query, opts = {}) {
  const hit = _cache.get(query, _normOpts(opts));
  if (!hit && REPORT_DIR) {
    const k = _reportKey(query, opts);
    _missCounts.set(k, (_missCounts.get(k) || 0) + 1);
    if (_written.has(k)) _missAfterWrite++;
  }
  return hit;
}

function set(query, opts, value) {
  _cache.set(query, _normOpts(opts), value);
  if (REPORT_DIR && value !== null && value !== undefined) _written.add(_reportKey(query, opts));
}

if (REPORT_DIR) {
  process.on('exit', () => {
    try {
      const fs = require('fs');
      const path = require('path');
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const top = [..._missCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
      fs.writeFileSync(path.join(REPORT_DIR, `serp-report-${path.basename(process.argv[1] || 'node')}-${process.pid}.json`), JSON.stringify({
        script: path.basename(process.argv[1] || ''),
        ...stats(),
        distinctMissed: _missCounts.size,
        missAfterWrite: _missAfterWrite,
        topMisses: top.map(([k, n]) => ({ n, key: JSON.parse(k) })),
      }));
    } catch { /* diagnostics only */ }
  });
}

function stats() {
  return _cache.stats();
}

function logStats(log = console.log) {
  _cache.logStats(log, 'SERP cache');
}

module.exports = { get, set, stats, logStats };
