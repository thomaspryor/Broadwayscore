/**
 * Pure decision function (Scraping v2 Sprint 1 T11): should opening-night-poller's
 * SERP backup layer (runSERPBackup, emptyAuthoritative:false) negative-cache an
 * empty result for this show, and for how long?
 *
 * Broadway is excluded on purpose. Reviews there can land within minutes of
 * curtain, and the poller's whole reason for existing is catching that window —
 * an empty SERP result must always be re-asked next tick, never trusted for 45
 * minutes. Off-Broadway and West End (including off-West-End, grouped the same
 * way isLondonMarket does elsewhere in this codebase) publish on slower, less
 * time-critical cycles: a 45-min negative cache cuts repeat BD/SB spend across
 * consecutive poll ticks without meaningfully delaying discovery there.
 *
 * Unknown/missing category defaults to null (no negative caching) — same
 * fail-safe-toward-freshness default as isBrightDataAllowedForShow in
 * opening-night-poller.js: better to over-ask than silently sit on a stale
 * empty answer for a misclassified show.
 */

const NEGATIVE_CACHE_TTL_MS = 45 * 60 * 1000;

function serpNegativeCacheTtlMs(show) {
  const category = (show && show.category) || '';
  if (category === 'off-broadway' || category === 'west-end' || category === 'off-west-end') {
    return NEGATIVE_CACHE_TTL_MS;
  }
  return null;
}

module.exports = { serpNegativeCacheTtlMs, NEGATIVE_CACHE_TTL_MS };
