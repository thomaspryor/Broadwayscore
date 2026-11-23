// BRO-8103: every id in collect-outlet-reviews.js MARKET_OUTLETS_FALLBACK must exist in the registry.
// LIVE-DATA-LANE: validates hardcoded ids against live data/outlet-registry.json (drift check, not a unit invariant)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MARKET_OUTLETS_FALLBACK } = require('./collect-outlet-reviews.js');
const reg = require('../data/outlet-registry.json').outlets;
const ids = new Set(Array.isArray(reg) ? reg.map(o => o.id) : Object.keys(reg));

test('fallback outlet ids all exist in outlet-registry.json', () => {
  const missing = [];
  for (const [market, tiers] of Object.entries(MARKET_OUTLETS_FALLBACK))
    for (const [tier, list] of Object.entries(tiers))
      for (const id of list) if (!ids.has(id)) missing.push(`${market}/${tier}/${id}`);
  assert.deepEqual(missing, []);
});
test('everything-theatre uses registry id', () => {
  assert.ok(MARKET_OUTLETS_FALLBACK['west-end'].tier3.includes('everything-theatre'));
});
