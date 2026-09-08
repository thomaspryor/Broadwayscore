/**
 * provider-credits.js — the credit cost of one call, per provider and mode.
 *
 * This is the provider's API contract (how many credits a tier bills), not
 * plan economics (what a credit costs in USD — see provider-pricing.js /
 * scripts/config/provider-pricing.json for that, a deliberately separate
 * lifecycle: USD rates change with the owner's plan, credit costs change
 * only when a provider ships a new tier).
 *
 * creditsFor() THROWS on an unknown (provider, mode) pair instead of
 * returning undefined. `NaN > budget` is false, so a silent undefined here
 * would disable a spend guard rather than fail loudly (CLAUDE.md rule 18 /
 * BRO-3009 design principle) — every caller must either handle a known mode
 * or crash, never coast on a missing key.
 *
 * Bright Data has no entry here: it bills a flat per-request rate with no
 * mode/tier concept, so there's nothing for creditsFor to look up — its rate
 * lives directly in provider-pricing.json instead.
 *
 * Leaf module: no requires, pure lookups only.
 */
'use strict';

const CREDITS = {
  sd: {
    plain: 1,
    dynamic: 5,
    premium: 10,
    stealth: 10,
    serp: 5,
  },
  // stealth (75cr) is ScrapingBee's stealth_proxy tier (collect-review-texts.js's
  // own SB fetcher). serp-news/serp-images share the plain serp rate — only the
  // telemetry `host` differs by search type, not the credit cost.
  sb: {
    standard: 1,
    render: 5,
    premium: 10,
    stealth: 75,
    serp: 25,
    'serp-news': 25,
    'serp-images': 25,
  },
};

function creditsFor(provider, mode) {
  const table = CREDITS[provider];
  if (!table || !Object.prototype.hasOwnProperty.call(table, mode)) {
    throw new Error(`creditsFor: unknown provider/mode "${provider}/${mode}"`);
  }
  return table[mode];
}

/** Throws on NaN/undefined/±Infinity instead of letting a bad value silently
 * pass a `cost > budget` comparison (NaN > budget is always false). */
function assertFiniteCost(n, label) {
  if (!Number.isFinite(n)) {
    throw new Error(`assertFiniteCost: ${label} is not a finite number (got ${n})`);
  }
  return n;
}

module.exports = { creditsFor, assertFiniteCost, CREDITS };
