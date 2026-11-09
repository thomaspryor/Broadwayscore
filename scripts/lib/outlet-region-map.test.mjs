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

test('infer: unanimous London categories also need a UK domain or three distinct shows', () => {
  assert.equal(inferOutletRegionFromCategories(['west-end'], isLondonMarket), null);
  assert.equal(inferOutletRegionFromCategories(['west-end'], isLondonMarket, { domain: 'reviews.co.uk' }), 'london');
  assert.equal(inferOutletRegionFromCategories(['west-end', 'off-west-end'], isLondonMarket,
    { london: ['w1', 'w2', 'w3'] }), 'london');
  for (const london of [['w1'], ['w1', 'w2'], ['w1', 'w1', 'w1']]) {
    assert.equal(inferOutletRegionFromCategories(['west-end'], isLondonMarket, { london }), null);
  }
  for (const domain of ['reviews.ca', 'reviews.in', 'reviews.co.uk.example.com', 'londonreviews.com']) {
    assert.equal(inferOutletRegionFromCategories(['west-end'], isLondonMarket, { domain }), null);
  }
  assert.equal(inferOutletRegionFromCategories(['west-end'], isLondonMarket,
    { domain: 'reviews.co.uk', london: ['w1', 'w2', 'w3'], nyc: ['n1'] }), null);
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
  const backfilled = backfillMissingOutletRegions(outlets, categories, isLondonMarket, '2026-08-15T00:00:00.000Z',
    { londonmumsmagazine: { london: new Set(['w1', 'w2', 'w3']) } });
  assert.deepEqual(backfilled, ['londonmumsmagazine']);
  assert.equal(outlets.londonmumsmagazine.region, 'london');
  assert.equal(outlets.londonmumsmagazine.regionInferredBy, 'backfillMissingOutletRegions (BRO-133)');
  assert.equal(outlets.londonmumsmagazine.regionInferredAt, '2026-08-15T00:00:00.000Z');
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
    a: { tier: 3, domain: 'reviews.co.uk' },
    b: { tier: 3, region: 'us' },
  };
  const categories = { a: new Set(['off-west-end']) };
  const backfilled = backfillMissingOutletRegions(outlets, categories, isLondonMarket);
  assert.deepEqual(backfilled, ['a']);
  assert.equal(outlets.a.region, 'london');
  assert.equal(outlets.b.region, 'us');
});

// ── BRO-5896: stamps are re-checked against the outlet's own evidence ────────
const { retractContradictedOutletRegions, regionEvidenceMarket } = require('./outlet-region-map.js');
const isLdn = (c) => c === 'west-end' || c === 'off-west-end';

test('backfill never re-stamps an outlet carrying regionCorrectedBy', () => {
  const outlets = { outinjersey: { regionCorrectedBy: 'BRO-5896' } };
  const out = backfillMissingOutletRegions(outlets, { outinjersey: new Set(['west-end']) }, isLdn, '2026-10-22T00:00:00.000Z');
  assert.deepEqual(out, []);
  assert.equal(outlets.outinjersey.region, undefined);
});

test('retract: NYC shows outnumber London shows -> region removed, marked corrected', () => {
  const outlets = { outinjersey: { region: 'london', regionInferredBy: 'backfillMissingOutletRegions (BRO-133)', regionInferredAt: 'x' } };
  const r = retractContradictedOutletRegions(outlets, { outinjersey: { london: new Set(), nyc: new Set(['a', 'b']) } }, 'T');
  assert.deepEqual(r, [{ id: 'outinjersey', londonShows: 0, nycShows: 2 }]);
  assert.equal(outlets.outinjersey.region, undefined);
  assert.equal(outlets.outinjersey.regionInferredBy, undefined);
  assert.equal(outlets.outinjersey.isDualMarket, undefined);
  assert.match(outlets.outinjersey.regionCorrectedBy, /2 NYC show\(s\) vs 0 London/);
  assert.equal(outlets.outinjersey.regionCorrectedAt, 'T');
  // and the backfill then leaves it alone
  assert.deepEqual(backfillMissingOutletRegions(outlets, { outinjersey: new Set(['west-end']) }, isLdn), []);
});

test('retract: a stamp that clears the bar keeps it while any London show exists', () => {
  // UK domain, or 3+ London shows: stale NYC flags may be true positives.
  const outlets = {
    ukdomain: { region: 'london', regionInferredBy: 'b', domain: 'reviews.co.uk' },
    threeshows: { region: 'london', regionInferredBy: 'b', domain: 'blog.com' },
  };
  const ev = {
    ukdomain: { london: ['w1'], nyc: ['n1', 'n2', 'n3'] },
    threeshows: { london: ['w1', 'w2', 'w3'], nyc: ['n1', 'n2', 'n3', 'n4'] },
  };
  assert.deepEqual(retractContradictedOutletRegions(outlets, ev), []);
  for (const id of Object.keys(outlets)) assert.equal(outlets[id].region, 'london', id);
});

// The card's title case: a pre-bar BRO-133 stamp from ONE West End review on a
// US .com domain. Before BRO-5896's weak-stamp route, its one London show kept
// the stamp forever and every NYC review it wrote was flagged and dropped.
test('retract: a weak legacy stamp outvoted by NYC shows is retracted', () => {
  const outlets = { usblog: { region: 'london', regionInferredBy: 'backfillMissingOutletRegions (BRO-133)', domain: 'usblog.com' } };
  const r = retractContradictedOutletRegions(outlets, { usblog: { london: ['w1'], nyc: ['n1', 'n2'] } }, 'T');
  assert.deepEqual(r, [{ id: 'usblog', londonShows: 1, nycShows: 2 }]);
  assert.equal(outlets.usblog.region, undefined);
  assert.match(outlets.usblog.regionCorrectedBy, /2 NYC show\(s\) vs 1 London/);
});

test('retract: a weak stamp is kept on a tie or London majority', () => {
  const outlets = {
    tie: { region: 'london', regionInferredBy: 'b', domain: 'x.com' },
    ldn: { region: 'london', regionInferredBy: 'b', domain: 'y.com' },
  };
  const ev = { tie: { london: ['w1', 'w2'], nyc: ['n1', 'n2'] }, ldn: { london: ['w1', 'w2'], nyc: ['n1'] } };
  assert.deepEqual(retractContradictedOutletRegions(outlets, ev), []);
});

test('meetsLondonStampBar: UK domain or three London shows', () => {
  const { meetsLondonStampBar } = require('./outlet-region-map.js');
  assert.equal(meetsLondonStampBar('reviews.co.uk', 0), true);
  assert.equal(meetsLondonStampBar('x.london', 1), true);
  assert.equal(meetsLondonStampBar('londonblog.com', 2), false);
  assert.equal(meetsLondonStampBar(null, 3), true);
  assert.equal(meetsLondonStampBar(undefined, 2), false);
});

test('retract: a single NYC show is not enough', () => {
  const outlets = { one: { region: 'london', regionInferredBy: 'b' } };
  assert.deepEqual(retractContradictedOutletRegions(outlets, { one: { nyc: ['n1'] } }), []);
});

test('retract: ties, London majority, hand-set and dual outlets are untouched', () => {
  const outlets = {
    tie: { region: 'london', regionInferredBy: 'b' },
    ukblog: { region: 'london', regionInferredBy: 'b' },
    hand: { region: 'london' },
    dual: { region: 'london', regionInferredBy: 'b', isDualMarket: true },
    corrected: { region: 'london', regionInferredBy: 'b', regionCorrectedBy: 'x' },
  };
  const ev = {
    tie: { london: ['w'], nyc: ['n'] },
    ukblog: { london: ['w1', 'w2', 'w3'], nyc: ['n1'] },
    hand: { nyc: ['n1', 'n2'] },
    dual: { nyc: ['n1', 'n2'] },
    corrected: { nyc: ['n1', 'n2'] },
  };
  assert.deepEqual(retractContradictedOutletRegions(outlets, ev), []);
  for (const id of Object.keys(outlets)) assert.equal(outlets[id].region, 'london', id);
});

test('retract: counts distinct shows, not files', () => {
  const outlets = { x: { region: 'london', regionInferredBy: 'b' } };
  // three NYC files on one show: one show, below the 2-show floor
  assert.deepEqual(retractContradictedOutletRegions(outlets, { x: { nyc: ['n', 'n', 'n'] } }), []);
});

test('regionEvidenceMarket: London evidence rejects unrelated wrong-production flags', () => {
  const base = { isLondonMarket: isLdn, trustworthyApartFromWrongProduction: true };
  assert.equal(regionEvidenceMarket({ ...base, category: 'west-end', trustworthy: true }), 'london');
  assert.equal(regionEvidenceMarket({ ...base, category: 'west-end', trustworthy: false,
    wrongProductionNote: 'Cross-market: London outlet "x" reviewing west-end show' }), null);
});

test('regionEvidenceMarket: only the forward guard assumption can bootstrap London evidence', () => {
  const evidence = { isLondonMarket: isLdn, category: 'west-end', trustworthy: false,
    trustworthyApartFromWrongProduction: true,
    wrongProductionNote: 'Cross-market: US outlet "blog" reviewing London show' };
  assert.equal(regionEvidenceMarket(evidence), 'london');
  for (const blocker of [
    { trustworthyApartFromWrongProduction: false },
    { wrongProductionReason: 'manual review' },
    { wrongProductionOverride: true },
    { wrongProductionProvenance: 'content' },
    { wrongProductionProvenance: 'manual' },
    { humanReviewedWrongProduction: true },
    { contentVerification: { wrongProduction: true } },
    { rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check', rejectionAgreeCount: 2 },
    { wrongProductionNote: `${evidence.wrongProductionNote}; confirmed wrong venue` },
    { category: 'regional' },
  ]) assert.equal(regionEvidenceMarket({ ...evidence, ...blocker }), null);
  assert.equal(regionEvidenceMarket({ ...evidence, review: { ...evidence, humanReviewedWrongProduction: true } }), null);
});

test('backfill: a registered .com blog can reach three London shows despite forward-guard flags', () => {
  const { evaluateForwardCrossMarketGuard, buildRegisteredOutletIds, buildOutletRegionMap } = require('./cross-market-guard');
  const { isReviewContentTrustworthy } = require('./review-guards');
  const registry = { outlets: { blog: { domain: 'reviewblog.com' } } };
  const categories = { blog: new Set() };
  const evidence = { blog: { london: new Set(), nyc: new Set() } };
  for (const showId of ['w1', 'w2', 'w3']) {
    const guard = evaluateForwardCrossMarketGuard({
      outletRegionMap: buildOutletRegionMap(registry),
      registeredOutletIds: buildRegisteredOutletIds(registry),
      canonicalOutlet: 'blog', rawOutlet: 'blog', url: 'https://reviewblog.com/review',
    });
    assert.equal(guard.shouldFlag, true);
    const review = { wrongProduction: guard.shouldFlag, wrongProductionNote: guard.reason };
    const market = regionEvidenceMarket({ category: 'off-west-end', isLondonMarket: isLdn,
      trustworthy: isReviewContentTrustworthy(review),
      trustworthyApartFromWrongProduction: isReviewContentTrustworthy({ ...review, wrongProduction: false }),
      wrongProductionNote: review.wrongProductionNote });
    assert.equal(market, 'london');
    categories.blog.add('off-west-end');
    evidence.blog[market].add(showId);
    const changed = backfillMissingOutletRegions(registry.outlets, categories, isLdn, 'T', evidence);
    assert.deepEqual(changed, showId === 'w3' ? ['blog'] : []);
  }
  assert.equal(evaluateForwardCrossMarketGuard({
    outletRegionMap: buildOutletRegionMap(registry), registeredOutletIds: buildRegisteredOutletIds(registry),
    canonicalOutlet: 'blog', rawOutlet: 'blog', url: 'https://reviewblog.com/review',
  }).shouldFlag, false);
});

test('regionEvidenceMarket: NYC side also counts the stale London-outlet flag', () => {
  const base = { isLondonMarket: isLdn, category: 'broadway' };
  assert.equal(regionEvidenceMarket({ ...base, trustworthy: true, trustworthyApartFromWrongProduction: true }), 'nyc');
  const stale = { ...base, trustworthy: false, trustworthyApartFromWrongProduction: true,
    wrongProductionNote: 'Cross-market: London outlet "outinjersey" reviewing broadway show' };
  assert.equal(regionEvidenceMarket(stale), 'nyc');
  assert.equal(regionEvidenceMarket({ ...stale, urlIsUk: true }), null, 'UK URL stays out');
  assert.equal(regionEvidenceMarket({ ...stale, trustworthyApartFromWrongProduction: false }), null, 'other defects stay out');
  assert.equal(regionEvidenceMarket({ ...stale, wrongProductionNote: 'Title collision' }), null, 'other flags stay out');
  assert.equal(regionEvidenceMarket({ ...stale, category: 'off-broadway' }), 'nyc');
});

test('regionEvidenceMarket: other categories are no evidence', () => {
  for (const category of ['regional', 'tour', undefined]) {
    assert.equal(regionEvidenceMarket({ isLondonMarket: isLdn, category, trustworthy: true, trustworthyApartFromWrongProduction: true }), null);
  }
});
