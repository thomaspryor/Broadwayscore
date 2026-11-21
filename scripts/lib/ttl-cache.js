/**
 * Generic disk-backed TTL cache. Generalized from scripts/lib/serp-cache.js
 * (Scraping v2 Sprint 1 T5) so any per-run memo — SERP results, BWW anchor
 * listings, etc — gets the same cheap dedup without re-deriving the pattern.
 *
 * Storage: {dir}/{sha1}.json. Callers that need CI persistence across job
 * steps (not just within a single node process) wire the same dir path into
 * an actions/cache@v4 step, same pattern serp-cache already uses for
 * /tmp/bd-serp-cache.
 *
 * Cached: any JSON-serializable value including empty arrays/objects (a
 * negative result IS a valid answer). Not cached: null/undefined (treat as
 * "caller doesn't know yet" — retry next time, don't freeze a failure).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * @param {object} opts
 * @param {string} opts.dir - cache directory (created on first write)
 * @param {number} opts.ttlMs - entry lifetime in milliseconds
 * @param {boolean} [opts.disabled] - bypass cache entirely (get always misses, set no-ops)
 * @returns {{ get: Function, set: Function, stats: Function, logStats: Function }}
 */
function createTtlCache({ dir, ttlMs, disabled = false }) {
  if (!dir) throw new Error('createTtlCache requires opts.dir');
  if (!(ttlMs > 0)) throw new Error('createTtlCache requires opts.ttlMs > 0');

  let _hits = 0;
  let _misses = 0;
  let _writes = 0;

  function _ensureDir() {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }

  function _keyFor(key, opts = {}) {
    const norm = JSON.stringify({
      k: String(key || '').trim().toLowerCase(),
      ...opts,
    });
    return crypto.createHash('sha1').update(norm).digest('hex');
  }

  function get(key, opts = {}) {
    if (disabled) return null;
    const file = path.join(dir, `${_keyFor(key, opts)}.json`);
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > ttlMs) {
        _misses++;
        return null;
      }
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      _hits++;
      return data;
    } catch {
      _misses++;
      return null;
    }
  }

  function set(key, opts, value) {
    if (disabled) return;
    if (value === null || value === undefined) return;
    _ensureDir();
    const file = path.join(dir, `${_keyFor(key, opts)}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify(value));
      _writes++;
    } catch { /* never crash the caller */ }
  }

  function stats() {
    const total = _hits + _misses;
    const hitRate = total > 0 ? (_hits / total * 100).toFixed(1) : '0.0';
    return { hits: _hits, misses: _misses, writes: _writes, hitRate: `${hitRate}%` };
  }

  function logStats(log = console.log, label = 'TTL cache') {
    const s = stats();
    if (s.hits + s.misses === 0) return;
    log(`  📦 ${label}: ${s.hits} hits, ${s.misses} misses (${s.hitRate} hit rate), ${s.writes} writes`);
  }

  return { get, set, stats, logStats };
}

module.exports = { createTtlCache };
