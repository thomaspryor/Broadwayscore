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

/**
 * gather-reviews press-night window (BRO-8323). A full gather re-runs every
 * 3h for days 1-3 after opening and re-asks ~150 outlet queries each time; on
 * 2026-11-25..26 a West End opening cost ~700-1,300 Scrapingdog credits per
 * pass, almost all of it empties already answered 3h earlier. For the markets
 * the owner allows 6-8h (everything but Broadway, same allowlist as
 * sb-market-gate.js) a 2.5h empty-answer cache drops the passes that land
 * within 2.5h of the last real ask. Replay of 2026-11-25..27 press-night
 * gather rows: 42% of those credits saved, no show's worst gap between real
 * asks grew (3h+ TTLs saved up to 57% but stretched one West End show from
 * 8.0h to 10.5h, past the 6-8h budget). Hits are never cached here (a found
 * review is on disk and skipped next pass anyway). Broadway and unknown
 * categories get null: every pass re-asks, exactly as before.
 * Kill switch: GATHER_SERP_NEGCACHE_DISABLED=1.
 */
const GATHER_NEGATIVE_CACHE_TTL_MS = 2.5 * 60 * 60 * 1000;

function gatherNegativeCacheTtlMs(show, env = process.env) {
  if (env.GATHER_SERP_NEGCACHE_DISABLED === '1') return null;
  const { GATED_CATEGORIES } = require('./sb-market-gate');
  return GATED_CATEGORIES.has((show && show.category) || '') ? GATHER_NEGATIVE_CACHE_TTL_MS : null;
}

/**
 * Options for one gather-reviews SERP call. {} (today's behaviour) unless the
 * call is a press-night one (emptyAuthoritative false: empties are otherwise
 * never cached) for a non-Broadway show.
 */
function gatherNegativeCacheOpts({ show, emptyAuthoritative } = {}, env = process.env) {
  if (emptyAuthoritative !== false) return {};
  const ttl = gatherNegativeCacheTtlMs(show, env);
  return ttl ? { negativeCacheTtlMs: ttl, negativeCacheStore: 'gather' } : {};
}

module.exports = { serpNegativeCacheTtlMs, NEGATIVE_CACHE_TTL_MS, gatherNegativeCacheTtlMs, gatherNegativeCacheOpts, GATHER_NEGATIVE_CACHE_TTL_MS };
