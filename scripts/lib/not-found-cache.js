/**
 * not-found cache for scripts/fetch-aggregator-pages.ts — per-aggregator
 * record of shows confirmed absent from Show Score / DTLI / BWW-RR, so a
 * genuine miss is served from cache instead of costing a live fetch on
 * every run. Extracted per CLAUDE.md rule 15 so the decision logic has one
 * source of truth shared by the fetcher and its test.
 */
const fs = require('fs');
const path = require('path');

function notFoundCachePath(archiveDir, aggregator) {
  return path.join(archiveDir, aggregator, '_not-found.json');
}

function loadNotFoundForAggregator(archiveDir, aggregator) {
  try {
    return JSON.parse(fs.readFileSync(notFoundCachePath(archiveDir, aggregator), 'utf8'));
  } catch {
    return {};
  }
}

function saveNotFoundForAggregator(archiveDir, aggregator, cache) {
  const dir = path.join(archiveDir, aggregator);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(notFoundCachePath(archiveDir, aggregator), JSON.stringify(cache, null, 2));
}

// Pure decision: should this show be skipped (served from the not-found
// cache) instead of attempting a live fetch? `force` always overrides.
function shouldSkipAsKnownNotFound(notFoundCache, showId, force) {
  return !force && Boolean(notFoundCache[showId]);
}

// Pure decision: how a completed fetch result updates the not-found cache.
// A success clears any stale not-found entry (the show has a real page now);
// a confirmed-absent result (result.notFoundReason) caches it; a transient
// failure (timeout, network error — notFoundReason falsy) leaves the cache
// untouched so it gets retried next run instead of being wrongly cached as
// absent. Returns a new object — does not mutate notFoundCache.
function applyFetchResultToCache(notFoundCache, showId, result, today) {
  const next = { ...notFoundCache };
  if (result.success) {
    delete next[showId];
  } else if (result.notFoundReason) {
    next[showId] = today;
  }
  return next;
}

module.exports = {
  notFoundCachePath,
  loadNotFoundForAggregator,
  saveNotFoundForAggregator,
  shouldSkipAsKnownNotFound,
  applyFetchResultToCache,
};
