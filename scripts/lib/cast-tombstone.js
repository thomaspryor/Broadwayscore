// Pure decision for backfill-cast.js's empty-result branch.
// Tested by tests/unit/cast-tombstone.test.mjs.
//
// When a lookupIBDBCast result has no Opening Night Cast, the backfill must
// decide whether to write an empty "tombstone" file (which permanently blocks
// re-scraping, since default runs skip shows that already have a cast file).
//
// Tombstone ONLY a genuine empty — a page that loaded and parsed fine but whose
// production has no cast on IBDB. NEVER tombstone a transient scrape failure
// (page didn't load / wasn't HTML / didn't parse / network error): that would
// turn one bad scrape into a permanently-empty show. Hamilton lost its entire
// cast this way on 2026-06-24 (a transient miss was tombstoned, then skipped on
// every subsequent run until a forced re-scrape).
function shouldTombstone(result) {
  return !(result && result.fetchFailed);
}

module.exports = { shouldTombstone };
