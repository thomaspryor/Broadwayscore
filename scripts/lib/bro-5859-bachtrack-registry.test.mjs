// BRO-5859: Bachtrack (London-based, reviews the Met and other New York houses)
// was registered as a London-only outlet, so the rebuild's reverse cross-market
// guard flagged its Met reviews ("Cross-market: London outlet reviewing
// off-broadway show"): lincoln-in-the-bardo and innocence off-broadway 2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registry = require('../../data/outlet-registry.json');
const guard = require('./cross-market-guard.js');
const { buildOutletMaps } = require('./outlet-region-map');
const { shouldAutoClearStaleLondonOutletCrossMarket } = require('./wrong-production-autoclear');

test('bachtrack is dual-market, so the reverse guard exempts it', () => {
  const o = registry.outlets.bachtrack;
  assert.equal(o.isDualMarket, true);
  assert.equal(o.region, 'dual');
  assert.ok(buildOutletMaps(registry).dualMarket.has('bachtrack'));
});

test('a stale London-outlet flag on its own bachtrack.com Met review self-heals', () => {
  const rec = {
    url: 'https://bachtrack.com/review-saariaho-innocence-malkki-didonato-metropolitan-opera-april-2026',
    publishDate: '2026-04-09',
    wrongProduction: true,
    wrongProductionNote: 'Cross-market: London outlet "bachtrack" reviewing off-broadway show',
  };
  assert.equal(shouldAutoClearStaleLondonOutletCrossMarket(rec, {
    isNycMarketShow: true,
    outletIsDualMarket: buildOutletMaps(registry).dualMarket.has('bachtrack'),
    urlOnOutletPrimaryDomain: true,
    isUkUrl: false,
    inOwnProductionWindow: true,
  }), true);
});

test('bachtrack London reviews still pass the forward guard on a West End show', () => {
  const maps = buildOutletMaps(registry);
  const r = guard.evaluateForwardCrossMarketGuard({
    outletRegionMap: maps.outletRegionMap,
    registeredOutletIds: guard.buildRegisteredOutletIds(registry),
    internationalTradeOutlets: maps.internationalTradeOutlets,
    canonicalOutlet: 'bachtrack',
    rawOutlet: 'bachtrack',
    url: 'https://bachtrack.com/review-x-royal-opera-house-london-october-2026',
    reviewDate: new Date('2026-10-04T00:00:00Z'),
  });
  assert.equal(r.shouldFlag, false, r.reason);
});
