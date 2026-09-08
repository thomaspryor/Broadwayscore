/**
 * fallback-attribution.js — what to stamp in a spend-ledger row's
 * `fallback_from` field, given the chain tier that ran (and failed, or was
 * blocked) immediately before it.
 *
 * BRO-3009 S1-T8. provider-telemetry.js has carried a `fallback_from` column
 * since task #752, but scraper.js never passed `opts.fallbackFrom`, so EVERY
 * row in data/audit/scraper-spend-ledger.jsonl reads `fallback_from: null` —
 * the ledger records what each tier cost but not why it ran. BRO-3011 (Sprint
 * 3) needs exactly that link to join spend against circuit-breaker trip
 * windows: "Bright Data's bill tripled on the 14th" is only actionable once
 * you can see that it tripled because Scrapingdog's day cap was shut.
 *
 * TELEMETRY ONLY. Nothing here decides whether a tier runs — pageChainOrder()
 * in scraper.js owns routing, and this function is called after that decision
 * has already been made and executed.
 *
 * The vocabulary is pageChainOrder's own tier names ('cookies-plain',
 * 'playwright-first', 'scrapingdog', 'brightdata', 'scrapingbee',
 * 'playwright-last'), deliberately not a second set of aliases — one
 * translation table is one place for the two to drift. The single exception is
 * the breaker case, which BRO-3009 specifies as the literal 'sd-breaker': a
 * tier that was never attempted is a materially different cost story from one
 * that was attempted and failed, and collapsing them would hide the very
 * signal Sprint 3 is built to read.
 *
 * Leaf module: no requires.
 */
'use strict';

/**
 * Reasons a tier declined to make its call at all. Reported by the tier
 * itself, per call — never inferred from shared module state. An earlier
 * revision of this file derived the breaker case from a delta on
 * scrapingdog-caps.js's module-global `blockedByBreaker` counter; that is
 * unsound and was caught in review. The counter is shared with concurrent
 * fetchPage() calls AND with url-discovery.js's SERP path, breaker state is
 * cached for 60s while an SD tier can await ~135s (two 45s attempts plus the
 * stealth retry), so a breaker that trips mid-await lets another caller's
 * block increment the counter and stamp 'sd-breaker' on a Bright Data row
 * whose Scrapingdog attempt actually ran and billed — corrupting exactly the
 * signal on exactly the day BRO-3011 cares about.
 */
const SKIP_REASONS = new Set([
  'sd-breaker',      // Scrapingdog daily circuit breaker (consultScrapingdog)
  'sd-quota',        // account exhausted (shouldSkipScrapingdogAtRuntime latch)
  'sd-budget',       // per-run SD_CREDIT_BUDGET spent
  'sd-unavailable',  // flag off / no API key
  'bd-budget',       // Bright Data daily cap (consultBrightData)
]);

/**
 * @param {string|null} prevTier  chain tier that ran immediately before the
 *   one about to be recorded — a pageChainOrder() name, or null for the first
 *   tier in the chain (nothing preceded it, so nothing to attribute).
 * @param {{skipReason?: string|null}} [opts]  skipReason: set when the
 *   previous tier declined to make the call at all, reported BY THAT TIER for
 *   THIS call (see SKIP_REASONS). Overrides the plain tier name, because
 *   "never attempted" and "attempted and missed" are opposite cost stories.
 * @returns {string|null} the `fallbackFrom` value to pass to recordBdCall /
 *   recordSbCall / recordSdCall, or null to leave the column empty.
 */
function fallbackFromLabel(prevTier, { skipReason = null } = {}) {
  if (!prevTier) return null;
  if (!skipReason) return prevTier;
  if (!SKIP_REASONS.has(skipReason)) {
    // Same principle as creditsFor(): an unrecognized value throws rather
    // than leaking a typo into the ledger, where BRO-3011 would silently
    // fail to match it and under-count the very windows it exists to find.
    throw new Error(`fallbackFromLabel: unknown skipReason "${skipReason}"`);
  }
  return skipReason;
}

module.exports = { fallbackFromLabel, SKIP_REASONS };
