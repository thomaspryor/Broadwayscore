/**
 * Disk-backed cache for SERP query results.
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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = process.env.BD_SERP_CACHE_DIR || '/tmp/bd-serp-cache';
const TTL_HOURS = Number(process.env.BD_SERP_CACHE_TTL_HOURS || 24);
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;
const DISABLED = process.env.BD_SERP_CACHE_DISABLED === '1';

let _hits = 0;
let _misses = 0;
let _writes = 0;

function _ensureDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
}

function _keyFor(query, opts = {}) {
  const norm = JSON.stringify({
    q: String(query || '').trim().toLowerCase(),
    geo: opts.geo || '',
    dateMin: opts.dateMin || '',
    dateMax: opts.dateMax || '',
  });
  return crypto.createHash('sha1').update(norm).digest('hex');
}

function get(query, opts = {}) {
  if (DISABLED) return null;
  const key = _keyFor(query, opts);
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > TTL_MS) {
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

function set(query, opts, value) {
  if (DISABLED) return;
  if (value === null || value === undefined) return;
  _ensureDir();
  const key = _keyFor(query, opts);
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(value));
    _writes++;
  } catch { /* never crash the scrape */ }
}

function stats() {
  const total = _hits + _misses;
  const hitRate = total > 0 ? (_hits / total * 100).toFixed(1) : '0.0';
  return { hits: _hits, misses: _misses, writes: _writes, hitRate: `${hitRate}%` };
}

function logStats(log = console.log) {
  const s = stats();
  if (s.hits + s.misses === 0) return;
  log(`  📦 SERP cache: ${s.hits} hits, ${s.misses} misses (${s.hitRate} hit rate), ${s.writes} writes`);
}

module.exports = { get, set, stats, logStats };
