/**
 * Opera-discovery 24h filesystem cache.
 *
 * Why: Sprint 2 added 7 new opera endpoints that walk outlet listing pages.
 * Without caching, every gather-reviews/opening-night-poller cron tick
 * re-walks the same pages — for ~6 active Met opera shows × 8 endpoints
 * that's ~50 fetches per cron, ~2400/day at the 30-min cadence. Pre-mortem
 * primary scenario: Alex Ross's New Yorker contributor page paginates to
 * 30+ pages each costing ~10 SB credits → SB_CREDIT_BUDGET=250 exhausted
 * in <6 hours.
 *
 * Strategy: per (outlet, showId, date) cache the URL-list output of each
 * endpoint's fetchAndParse for 24h. First cron of a UTC-day spends real
 * credits; remaining 47 cron ticks read the file and consume 0.
 *
 * Atomic write: tmpfile + rename so a partial write never produces a
 * half-cached entry. fsync after the write so a crash doesn't leave the
 * file in the page cache only.
 *
 * Bypass: opt-out by passing `bypass: true` to withOperaCache(). Useful
 * for one-shot audits (scripts/audit-opera-discovery-gap.js).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'cache', 'opera-discovery');
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
// Per-show fetch cap (cache-misses only — cache hits are free). Default 30
// is enough for one cache-miss per opera outlet on a typical opera show.
// Env override: OPERA_PER_SHOW_FETCH_CAP=N. Set to 0 to disable.
const PER_SHOW_CAP = (() => {
  const raw = parseInt(process.env.OPERA_PER_SHOW_FETCH_CAP || '30', 10);
  return Number.isFinite(raw) ? raw : 30;
})();
// Process-local counter: showId → cache-miss fetch count.
const _perShowFetchCount = new Map();
// Process-local set: shows that have already logged the cap-hit warning,
// so we don't spam the log every subsequent capped call within the same run.
const _perShowWarned = new Set();

function _today() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function _ensureCacheDir() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

function _cachePath(outletId, showId) {
  // showId can contain unsafe chars in some corpus shapes; keep it simple
  // by base64-encoding it. Outlet IDs are already kebab-safe.
  const safeShowId = Buffer.from(String(showId || 'unknown')).toString('base64url');
  return path.join(CACHE_DIR, `${outletId}-${safeShowId}-${_today()}.json`);
}

function _readIfFresh(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > TTL_MS) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    // Corrupt cache entry — let caller re-fetch and overwrite.
    return null;
  }
}

function _atomicWrite(filePath, value) {
  _ensureCacheDir();
  const tmp = path.join(CACHE_DIR, `.tmp-${path.basename(filePath)}.${process.pid}.${Date.now()}`);
  const json = JSON.stringify(value);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/**
 * Wrap an async function call with the opera-discovery 24h cache.
 *
 * @param {Object} opts
 * @param {string} opts.outletId — e.g. 'vulture-opera'
 * @param {string} opts.showId — e.g. 'tristan-und-isolde-off-broadway-2026'
 * @param {boolean} [opts.bypass=false] — opt out (audits / dev)
 * @param {Function} fn — async () => string[]  (the URL list)
 * @returns {Promise<string[]>}
 */
async function withOperaCache(opts, fn) {
  // Env bypass: audit/dev scripts set this so re-runs read fresh data.
  if (process.env.OPERA_DISCOVERY_BYPASS_CACHE === '1') return fn();
  if (opts && opts.bypass) return fn();
  if (!opts || !opts.outletId || !opts.showId) {
    // Missing key fields: never cache. Caller is wrong, but don't crash
    // discovery — just bypass and log once.
    if (!withOperaCache._warned) {
      console.warn('    [opera-cache] missing outletId/showId, bypassing cache');
      withOperaCache._warned = true;
    }
    return fn();
  }
  const filePath = _cachePath(opts.outletId, opts.showId);
  const cached = _readIfFresh(filePath);
  if (cached !== null) {
    console.log(`    [opera-cache] HIT ${opts.outletId} ${opts.showId} (${cached.length} URLs)`);
    return cached;
  }
  // Per-show fetch cap — only counts cache misses (real expensive fetches).
  // Protects subsequent shows in the cron loop from a single runaway show
  // exhausting the SB/BD budget.
  if (PER_SHOW_CAP > 0) {
    const current = _perShowFetchCount.get(opts.showId) || 0;
    if (current >= PER_SHOW_CAP) {
      if (!_perShowWarned.has(opts.showId)) {
        console.warn(`    [opera-cache] CAP-HIT ${opts.showId} reached ${PER_SHOW_CAP} cache-miss fetches this run; skipping ${opts.outletId} and remaining opera outlets`);
        _perShowWarned.add(opts.showId);
      }
      return [];
    }
    _perShowFetchCount.set(opts.showId, current + 1);
  }
  const fresh = await fn();
  // Don't cache empty results. Empty arrays are normal in the pre-publication
  // window (Playbill roundup before the article posts, author archive before
  // a review lands) — caching them for 24h would silently kill the discovery
  // window. The cost of re-fetching empty results is bounded by the per-show
  // fetch cap (counted above) so re-trying isn't a budget risk.
  if (Array.isArray(fresh) && fresh.length > 0) {
    try {
      _atomicWrite(filePath, fresh);
    } catch (e) {
      console.warn(`    [opera-cache] write failed for ${opts.outletId}/${opts.showId}: ${e.message}`);
    }
  } else if (Array.isArray(fresh) && fresh.length === 0) {
    console.log(`    [opera-cache] not caching empty result for ${opts.outletId}/${opts.showId}`);
  }
  return fresh;
}

module.exports = {
  withOperaCache,
  _CACHE_DIR: CACHE_DIR,
  _TTL_MS: TTL_MS,
};
