// BRO-5376: Seen and Heard International (UK-based, covers London + NYC) had no
// region/isDualMarket in the registry, so the forward cross-market guard flagged
// its London reviews as "US outlet reviewing London show". gaytimes.com also
// lacked a domainAliases entry, so the ingest write-guard refused its reviews.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registry = require('../../data/outlet-registry.json');
const guard = require('./cross-market-guard.js');
const { buildOutletMaps } = require('./outlet-region-map');

test('seen-and-heard-international is dual-market and not flagged on a London show', () => {
  const o = registry.outlets['seen-and-heard-international'];
  assert.equal(o.isDualMarket, true);
  assert.equal(o.region, 'dual');
  const maps = buildOutletMaps(registry);
  const r = guard.evaluateForwardCrossMarketGuard({
    outletRegionMap: maps.outletRegionMap,
    registeredOutletIds: guard.buildRegisteredOutletIds(registry),
    internationalTradeOutlets: maps.internationalTradeOutlets,
    canonicalOutlet: 'seen-and-heard-international',
    rawOutlet: 'seen-and-heard-international',
    url: 'https://seenandheard-international.com/2026/10/x/',
    reviewDate: new Date('2026-10-04T00:00:00Z'),
  });
  assert.equal(r.shouldFlag, false, r.reason);
});

test('gay-times accepts gaytimes.com as a domain alias', () => {
  assert.ok(registry.outlets['gay-times'].domainAliases.includes('gaytimes.com'));
});
