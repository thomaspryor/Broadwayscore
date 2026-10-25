// Pure decision for backfill-cast.js's empty-result branch.
// Tested by tests/unit/cast-tombstone.test.mjs.
//
// When a lookupIBDBCast result has no Opening Night Cast, the backfill must
// decide whether to write an empty "tombstone" file (which permanently blocks
// re-scraping, since default runs skip shows that already have a cast file).
//
// A wrong-production IBDB page (productionMismatch) is not a genuine empty either:
// the right production may exist later, so never lock the show out (BRO-5809).
// Tombstone ONLY a genuine empty — a page that loaded and parsed fine but whose
// production has no cast on IBDB. NEVER tombstone a transient scrape failure
// (page didn't load / wasn't HTML / didn't parse / network error): that would
// turn one bad scrape into a permanently-empty show. Hamilton lost its entire
// cast this way on 2026-06-24 (a transient miss was tombstoned, then skipped on
// every subsequent run until a forced re-scrape).
function shouldTombstone(result) {
  return !(result && (result.fetchFailed || result.productionMismatch));
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

// Announced shows have no openingDate, so the year check above never fired and
// a stored/searched IBDB URL for an earlier run supplied that cast (BRO-5809:
// private-lives-2025 carried the 1948 Tallulah Bankhead cast). Fall back to the
// previews year, then to the year the show id carries ("-2025").
function expectedOpeningYear(show) {
  if (!show) return null;
  for (const d of [show.openingDate, show.previewsStartDate]) {
    const m = /^((?:18|19|20)\d{2})/.exec(d || '');
    if (m) return parseInt(m[1], 10);
  }
  // id year is only trusted while the show has not opened (ids of long runners drift from their dates)
  if (show.status && show.status !== 'announced' && show.status !== 'upcoming') return null;
  const idm = /-((?:19|20)\d{2})$/.exec(show.id || '');
  return idm ? parseInt(idm[1], 10) : null;
}

// Why a data/cast file may NOT be copied onto its show, or null when it may.
// 'year-mismatch': IBDB production year is more than a year off the show's year.
// 'unverified-ibdb': an IBDB-sourced file for a show that has not opened and
// whose file records no production year, so nothing proves which run it is.
function castFileMismatchReason(castData, show) {
  if (!castData || !show) return null;
  const expected = expectedOpeningYear(show);
  if (isProductionYearMismatch(castData.productionYear, expected)) return 'year-mismatch';
  const unopened = !show.openingDate && (show.status === 'announced' || show.status === 'upcoming' || !show.status);
  if (unopened && castData.ibdbUrl && !castData.productionYear) return 'unverified-ibdb';
  return null;
}

module.exports = {
  shouldTombstone, shouldAbortMassWipe, parseIbdbProductionYear, isProductionYearMismatch,
  expectedOpeningYear, castFileMismatchReason,
};
