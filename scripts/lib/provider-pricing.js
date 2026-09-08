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
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PRICING_PATH = path.join(__dirname, '..', 'config', 'provider-pricing.json');

let _cache = null;
function loadProviderPricing() {
  if (!_cache) {
    _cache = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));
  }
  return _cache;
}

function usdFor(provider, units, pricingTable = loadProviderPricing()) {
  const rate = pricingTable[provider];
  if (!rate || !Number.isFinite(rate.usdPerUnit)) {
    throw new Error(`usdFor: no pricing configured for provider "${provider}"`);
  }
  return units * rate.usdPerUnit;
}

module.exports = { loadProviderPricing, usdFor };
