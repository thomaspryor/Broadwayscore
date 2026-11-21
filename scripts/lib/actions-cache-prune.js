'use strict';

// Pure decision logic for pruning run-id-keyed GitHub Actions caches
// (BRO-4146). A cache key carrying github.run_id makes actions/cache@v5
// mint a brand-new immutable entry every run — nothing ever collapses or
// deletes the old ones on its own. Left unchecked they accumulate forever
// until the repo-wide 10 GiB cap is hit, at which point GitHub LRU-evicts
// the WHOLE cache namespace, including unrelated tiny caches (this is the
// BRO-3887 bd-serp-cache incident, recurring from a second source measured
// 2026-09-25: nextjs-cache-Linux-* had grown to 24 entries / 5.3 GiB against
// an assumed "tens of MB").
//
// Given the live cache entries for one key prefix, keep the newest N (by
// createdAt) and return the rest, oldest first, for deletion.
function selectCacheEntriesToPrune(entries, { keepNewest = 2 } = {}) {
  const sorted = [...entries].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return sorted.slice(keepNewest).reverse();
}

module.exports = { selectCacheEntriesToPrune };
