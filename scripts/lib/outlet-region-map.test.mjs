import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildOutletMaps } = require('./outlet-region-map.js');

const REG = {
  outlets: {
    'times-uk': { region: 'london', isDualMarket: true, tier: 1, aliases: ['The Times', 'TimesUK'] },
    'evening-standard': { region: 'london', tier: 1, aliases: ['Evening Standard'] },
    'whatsonstage': { market: 'west-end', tier: 3 }, // region falls back to 'london'
    'nytimes': { region: 'new-york', tier: 1, aliases: ['NYT'] },
    'noregion-outlet': { tier: 4 }, // no region, no west-end market -> absent from regionMap
  },
};

test('region map includes id + LOWERCASED aliases (ship-check 2026-06-15 nuance)', () => {
  const { outletRegionMap } = buildOutletMaps(REG);
  assert.equal(outletRegionMap['times-uk'], 'london');
  assert.equal(outletRegionMap['the times'], 'london'); // alias lowercased
  assert.equal(outletRegionMap['timesuk'], 'london');
  assert.equal(outletRegionMap['nyt'], 'new-york');
});

test('west-end market with no explicit region falls back to london', () => {
  const { outletRegionMap } = buildOutletMaps(REG);
  assert.equal(outletRegionMap['whatsonstage'], 'london');
});

test('outlet with no region and no west-end market is absent from the region map', () => {
  const { outletRegionMap } = buildOutletMaps(REG);
  assert.equal(outletRegionMap['noregion-outlet'], undefined);
});

test('dualMarket set carries id + lowercased aliases', () => {
  const { dualMarket } = buildOutletMaps(REG);
  assert.ok(dualMarket.has('times-uk'));
  assert.ok(dualMarket.has('the times'));
  assert.ok(!dualMarket.has('evening-standard'));
});

test('tier12Outlets + tier map; non-tier1/2 excluded from tier12 set', () => {
  const { tier12Outlets, outletTierMap } = buildOutletMaps(REG);
  assert.ok(tier12Outlets.has('times-uk'));
  assert.ok(tier12Outlets.has('the times'));
  assert.ok(!tier12Outlets.has('whatsonstage')); // tier 3
  assert.equal(outletTierMap['whatsonstage'], 3);
});

test('canonicalOutletId maps aliases back to canonical id', () => {
  const { canonicalOutletId } = buildOutletMaps(REG);
  assert.equal(canonicalOutletId['the times'], 'times-uk');
  assert.equal(canonicalOutletId['times-uk'], 'times-uk');
});

test('empty / missing registry does not throw', () => {
  assert.doesNotThrow(() => buildOutletMaps({}));
  assert.doesNotThrow(() => buildOutletMaps(null));
  assert.equal(Object.keys(buildOutletMaps(null).outletRegionMap).length, 0);
});

// ── inferOutletRegionFromCategories (task #817) ──────────────────────────────
const { inferOutletRegionFromCategories } = require('./outlet-region-map.js');
const isLondonMarket = (c) => c === 'west-end' || c === 'off-west-end';

test('infer: outlet seen only on London-market shows gets region london', () => {
  assert.equal(inferOutletRegionFromCategories(['west-end'], isLondonMarket), 'london');
  assert.equal(inferOutletRegionFromCategories(['west-end', 'off-west-end'], isLondonMarket), 'london');
});

test('infer: NYC-market evidence deliberately does NOT stamp a region (would disable urlIsUK fallback)', () => {
  assert.equal(inferOutletRegionFromCategories(['broadway'], isLondonMarket), null);
  assert.equal(inferOutletRegionFromCategories(['broadway', 'off-broadway'], isLondonMarket), null);
});

test('infer: mixed or empty market evidence leaves region unset', () => {
  assert.equal(inferOutletRegionFromCategories(['west-end', 'broadway'], isLondonMarket), null);
  assert.equal(inferOutletRegionFromCategories([], isLondonMarket), null);
  assert.equal(inferOutletRegionFromCategories(null, isLondonMarket), null);
  assert.equal(inferOutletRegionFromCategories([null, undefined], isLondonMarket), null);
});

test('infer: regional/unknown categories do not force a region', () => {
  assert.equal(inferOutletRegionFromCategories(['regional'], isLondonMarket), null);
  assert.equal(inferOutletRegionFromCategories(['broadway', 'regional'], isLondonMarket), null);
});

// ── backfillMissingOutletRegions (BRO-133) ────────────────────────────────
const { backfillMissingOutletRegions } = require('./outlet-region-map.js');

test('backfill: fills region on a pre-existing region-less outlet with unanimous London evidence', () => {
  const outlets = { londonmumsmagazine: { displayName: 'Londonmumsmagazine', tier: 3, aliases: ['londonmumsmagazine'], domain: 'londonmumsmagazine.com' } };
  const categories = { londonmumsmagazine: new Set(['off-west-end']) };
  const backfilled = backfillMissingOutletRegions(outlets, categories, isLondonMarket);
  assert.deepEqual(backfilled, ['londonmumsmagazine']);
  assert.equal(outlets.londonmumsmagazine.region, 'london');
});

test('backfill: leaves outlets with an existing region untouched', () => {
  const outlets = { nytimes: { region: 'new-york', tier: 1 } };
  const categories = { nytimes: new Set(['west-end']) };
  const backfilled = backfillMissingOutletRegions(outlets, categories, isLondonMarket);
  assert.deepEqual(backfilled, []);
  assert.equal(outlets.nytimes.region, 'new-york');
});

test('backfill: skips isDualMarket outlets even when region-less', () => {
  const outlets = { 'times-uk': { isDualMarket: true, tier: 1 } };
  const categories = { 'times-uk': new Set(['west-end']) };
  const backfilled = backfillMissingOutletRegions(outlets, categories, isLondonMarket);
  assert.deepEqual(backfilled, []);
  assert.equal(outlets['times-uk'].region, undefined);
});

test('backfill: leaves outlets with mixed/no market evidence region-less', () => {
  const outlets = { blog: {}, silent: {} };
  const categories = { blog: new Set(['west-end', 'broadway']) };
  const backfilled = backfillMissingOutletRegions(outlets, categories, isLondonMarket);
  assert.deepEqual(backfilled, []);
  assert.equal(outlets.blog.region, undefined);
  assert.equal(outlets.silent.region, undefined);
});

test('backfill: mutates the outlets object in place and returns only the changed ids', () => {
  const outlets = {
    a: { tier: 3 },
    b: { tier: 3, region: 'us' },
  };
  const categories = { a: new Set(['off-west-end']) };
  const backfilled = backfillMissingOutletRegions(outlets, categories, isLondonMarket);
  assert.deepEqual(backfilled, ['a']);
  assert.equal(outlets.a.region, 'london');
  assert.equal(outlets.b.region, 'us');
});
