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
 * @param {string|null} prevTier  chain tier that ran immediately before the
 *   one about to be recorded — a pageChainOrder() name, or null for the first
 *   tier in the chain (nothing preceded it, so nothing to attribute).
 * @param {{breakerBlocked?: boolean}} [opts]  breakerBlocked: the previous
 *   tier returned no result because a circuit breaker refused the call, not
 *   because the provider was tried and missed.
 * @returns {string|null} the `fallbackFrom` value to pass to recordBdCall /
 *   recordSbCall / recordSdCall, or null to leave the column empty.
 */
function fallbackFromLabel(prevTier, { breakerBlocked = false } = {}) {
  if (!prevTier) return null;
  if (breakerBlocked && prevTier === 'scrapingdog') return 'sd-breaker';
  return prevTier;
}

module.exports = { fallbackFromLabel };
