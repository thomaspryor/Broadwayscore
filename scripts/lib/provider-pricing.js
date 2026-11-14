/**
 * provider-pricing.js — USD rate lookup over scripts/config/provider-pricing.json.
 *
 * Split from provider-credits.js on purpose (BRO-3009 design principle): a
 * credit's cost in USD is plan economics the owner can renegotiate any time
 * (it changed twice in one quarter) — it does not belong in a code leaf, and
 * it must never be read anywhere except through this file, so a future rate
 * change is a one-file JSON edit.
 *
 * usdFor() is pure — it takes an already-loaded pricing table rather than
 * doing its own I/O, so callers that need a pure decision function (e.g. a
 * chain-escalation test) can pass a fixture table with zero fs access.
 * loadProviderPricing() is the one I/O boundary real callers use to get that
 * table (cached after first read).
 *
 * usdFor() imports assertFiniteCost from provider-credits.js rather than
 * duplicating a 3-line finite-number guard — a one-directional require
 * (provider-credits.js has zero requires of its own, so no cycle) that
 * doesn't touch the pricing/credits lifecycle split described above.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { assertFiniteCost } = require('./provider-credits');

const PRICING_PATH = path.join(__dirname, '..', 'config', 'provider-pricing.json');

let _cache = null;
function loadProviderPricing() {
  if (!_cache) {
    _cache = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));
  }
  return _cache;
}

// `billing: 'payg'` selects rate.paygUsdPerUnit instead of rate.usdPerUnit —
// e.g. Scrapingdog's PAYG add-on rate ($0.0004/credit) vs its prepaid plan
// rate ($0.00009/credit). No production caller passes this yet (BRO-3057:
// there's no runtime signal anywhere for "SD is currently billing PAYG
// rather than being skipped" — see scrapingdog-ack.js), but the option
// exists and is validated/tested so paygUsdPerUnit has a real consumer
// instead of zero.
function usdFor(provider, units, pricingTable = loadProviderPricing(), { billing } = {}) {
  const rate = pricingTable[provider];
  if (!rate || !Number.isFinite(rate.usdPerUnit)) {
    throw new Error(`usdFor: no pricing configured for provider "${provider}"`);
  }
  // Explicit enum, not a truthy/falsy fallthrough: a typo like {billing:'PAYG'}
  // must throw, not silently ride the prepaid rate — exactly the class of
  // silent-wrong-cost bug this file exists to prevent.
  if (billing !== undefined && billing !== 'payg') {
    throw new Error(`usdFor: unknown billing mode "${billing}" (expected undefined or "payg")`);
  }
  let perUnit = rate.usdPerUnit;
  if (billing === 'payg') {
    if (!Number.isFinite(rate.paygUsdPerUnit)) {
      throw new Error(`usdFor: no paygUsdPerUnit configured for provider "${provider}"`);
    }
    perUnit = rate.paygUsdPerUnit;
  }
  // Validate perUnit itself, not just the product — units=0 would otherwise
  // let a negative configured rate produce -0 and pass unnoticed.
  assertFiniteCost(perUnit, `usdFor(${provider}): perUnit`);
  assertFiniteCost(units, `usdFor(${provider}): units`);
  return assertFiniteCost(units * perUnit, `usdFor(${provider}): result`);
}

module.exports = { loadProviderPricing, usdFor };
