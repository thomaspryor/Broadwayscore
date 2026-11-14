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
 *
 * BRO-3057: keys are the LITERAL mode strings production call sites already
 * hold in a local variable — never invented aliases. sd's page/render/premium/
 * stealth match scraper.js's fetchWithScrapingdog mode ternary (also used for
 * its recordSdCall telemetry). sb has two synonym key-sets for the same cost
 * points because two independent call sites named their tiers differently
 * before this file existed: page/render/premium is scraper.js's
 * fetchWithScrapingBee mode ternary; standard/premium_proxy/stealth_proxy is
 * collect-review-texts.js's `proxyType`, which doubles as a real ScrapingBee
 * API param value, so it can't be renamed to match. Not collapsing the two
 * sets — doing so would mean changing a live API param string for a naming
 * preference. serp/serp-news/serp-images (url-discovery.js) share one rate;
 * only the telemetry `host` differs by search type, not the credit cost.
 *
 * The SB call sites named in BRO-3072 (scraper.js, site-search-discovery.js, reddit-api.js,
 * check-cookie-health.js) derive credits from here; tests/unit/sb-credits-no-literals.test.mjs
 * covers top-level scripts/ and scripts/lib/ .js files only. reddit-api.js still hand-codes
 * the SD tier table (follow-up).
 */
'use strict';

const CREDITS = {
  sd: {
    page: 1,
    render: 5,
    premium: 10,
    stealth: 10,
    serp: 5,
    'serp-images': 10, // google_images endpoint (BRO-3377)
    // BRO-4665: dedicated YouTube APIs (scraper.js fetchScrapingdogYouTube).
    'youtube-transcripts': 1,
    'youtube-video': 5,
  },
  sb: {
    page: 1,
    render: 5,
    premium: 10,
    standard: 1,
    premium_proxy: 10,
    render_premium: 25, // render_js + premium_proxy (check-cookie-health.js cookie probe, BRO-4215)
    stealth_proxy: 75,
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

/** Throws on NaN/undefined/±Infinity/negative instead of letting a bad value
 * silently pass a `cost > budget` comparison (NaN > budget is always false —
 * and a negative cost accumulated into a running total, e.g.
 * `_scraperStats.sdCredits += creditCost`, would silently shrink it below
 * real spend, the same class of hazard by a different route). Zero is a
 * legitimate cost (a free tier, a cache hit) and stays allowed. */
function assertFiniteCost(n, label) {
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`assertFiniteCost: ${label} is not a finite non-negative number (got ${n})`);
  }
  return n;
}

module.exports = { creditsFor, assertFiniteCost, CREDITS };
