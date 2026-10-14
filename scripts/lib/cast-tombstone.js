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

// Mass-wipe circuit breaker for --force backfill runs. A scraper regression
// that makes every fetch look like a genuine empty (the exact Cloudflare
// class above) would otherwise sail through shouldTombstone() one show at a
// time with no aggregate check. Trips when the wiped share of previously-
// populated cast files this run crosses `threshold` — the caller restores
// its backed-up files and aborts (task #712, wiped 29-30 shows twice: Jul 29
// and again Aug 5 when the fix hadn't landed yet).
function shouldAbortMassWipe(populatedBefore, wipedCount, threshold = 0.3) {
  if (!populatedBefore || populatedBefore <= 0) return false;
  return (wipedCount / populatedBefore) > threshold;
}

// IBDB <title> reads "The Imaginary Invalid – Broadway Play – 1967 Revival | IBDB".
// A stored ibdbUrl skips title validation, so a URL pointing at an earlier
// production of the same title silently imports THAT cast (BRO-4171: the 2026
// Roundabout revival got the 1967 cast — Denholm Elliott et al.).
function parseIbdbProductionYear(docTitle) {
  const m = /\b((?:18|19|20)\d{2})\s+(?:Revival|Original|Production)\b/i.exec(docTitle || '');
  return m ? parseInt(m[1], 10) : null;
}

// True only when both years are known and the IBDB production is more than a
// year away from the show's opening year (tryout/previews straddle New Year).
function isProductionYearMismatch(productionYear, openingYear) {
  if (!productionYear || !openingYear) return false;
  return Math.abs(productionYear - openingYear) > 1;
}

module.exports = { shouldTombstone, shouldAbortMassWipe, parseIbdbProductionYear, isProductionYearMismatch };
