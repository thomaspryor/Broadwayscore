/**
 * BRO-254 follow-up: validateBWWRoundupGeography()'s NON_LOCAL_OUTLET_IDS was
 * re-derived from the outlet-registry-to-region-map pattern inline instead of
 * using scripts/lib/outlet-region-map.js's buildOutletMaps() (the canonical
 * single source of truth). Consolidated onto it — this fixed a narrow gap:
 * outlets with market:'west-end' but no explicit region field (e.g.
 * 'matttrueman') were never treated as non-local for Broadway validation
 * under the old inline logic, since it only read the explicit region field.
 *
 * Run: node --test tests/unit/gather-reviews-bww-geography.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateBWWRoundupGeography } = require('../../scripts/gather-reviews.js');

// These tests read the real registry through gather-reviews.js's own
// loadOutlets(), so their fixtures are only meaningful while the outlets they
// name still carry the region the test is about. BRO-3251 is an open audit to
// retag region:'us' outlets — if frontmezzjunkies becomes 'nyc', the two
// region:'us' tests below would pass VACUOUSLY ('nyc' is Broadway-local and
// non-local for WE, so both assertions still hold while testing nothing).
// Silent coverage loss is worse than a false alarm, so assert the precondition
// and fail loudly instead.
const outletRegistry = require('../../data/outlet-registry.json');
const REGISTRY = outletRegistry.outlets || outletRegistry;
const US_REGION_FIXTURE = 'frontmezzjunkies';

test("precondition: the region:'us' fixture outlet is still tagged region:'us'", () => {
  assert.equal(
    REGISTRY[US_REGION_FIXTURE]?.region,
    'us',
    `${US_REGION_FIXTURE} was retagged (BRO-3251?) — the two region:'us' tests below now pass vacuously. Point US_REGION_FIXTURE at another region:'us' outlet, or delete these tests if no outlet carries 'us' any more.`,
  );
});

test('a review from a London-only outlet (matttrueman, market:west-end, no explicit region) is filtered from a Broadway roundup', () => {
  // 3 reviews so the single non-local outlet (1/3 = 0.33) stays under the
  // >=0.5 "reject entire roundup" threshold and hits the per-review filter
  // path. Keep at least 2 local reviews per non-local one in these fixtures —
  // adding a second non-local outlet here tips the ratio and silently switches
  // the test onto the whole-roundup-rejection path instead.
  // (nytimes/variety carry no `region` field at all; they count as local by
  // absence, which is load-bearing for the ratio above.)
  const reviews = [
    { outletId: 'nytimes', excerpt: 'a Broadway review' },
    { outletId: 'variety', excerpt: 'another Broadway review' },
    { outletId: 'matttrueman', excerpt: 'a London freelance critic review' },
  ];
  const result = validateBWWRoundupGeography(reviews, '', 'some-broadway-show-2026', false);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(r => r.outletId).sort(), ['nytimes', 'variety']);
});

test('a review from a London-only outlet (matttrueman) is NOT filtered from a West End roundup', () => {
  const reviews = [
    { outletId: 'matttrueman', excerpt: 'a London freelance critic review' },
  ];
  const result = validateBWWRoundupGeography(reviews, '', 'some-west-end-show-2026', true);
  assert.equal(result.length, 1);
});

test('an empty reviews array returns unchanged (no-op, never throws)', () => {
  assert.deepEqual(validateBWWRoundupGeography([], '', 'show-id', false), []);
});

/**
 * BRO-3247 (2026-09-14): the Broadway-local region set here was {nyc, national},
 * but loadOutlets()'s own US_REGIONS discovery whitelist tags exactly the same
 * class of domestic tier-3 outlet with region:'us' (frontmezzjunkies,
 * blogcritics, cititour, stageandcinema, ...). Reading that field with the
 * narrower set meant every 'us' outlet was simultaneously discoverable by SERP
 * and excluded from BWW roundups as "non-local" — Front Mezz Junkies' real
 * Safe House review was dropped this way. Fix: 'us' joined the local set.
 */
test("region:'us' outlets (frontmezzjunkies) are Broadway-local, not filtered from a Broadway roundup", () => {
  const reviews = [
    { outletId: 'nytimes', excerpt: 'a Broadway review' },
    { outletId: 'variety', excerpt: 'another Broadway review' },
    { outletId: 'frontmezzjunkies', excerpt: 'a NYC blogger review' },
  ];
  const result = validateBWWRoundupGeography(reviews, '', 'safe-house-off-broadway-2026', false);
  assert.equal(result.length, 3, 'no review should be dropped');
  assert.ok(result.some(r => r.outletId === 'frontmezzjunkies'),
    "region:'us' outlet must survive the Broadway geography filter");
});

test("region:'us' outlets are still non-local for a West End roundup", () => {
  // Guard rail: widening the Broadway set must not leak into the WE branch,
  // which keeps its own {london, national-uk, national} local set.
  const reviews = [
    { outletId: 'thestage', excerpt: 'a London review' },
    { outletId: 'whatsonstage', excerpt: 'another London review' },
    { outletId: 'frontmezzjunkies', excerpt: 'a NYC blogger review' },
  ];
  const result = validateBWWRoundupGeography(reviews, '', 'some-west-end-show-2026', true);
  assert.ok(!result.some(r => r.outletId === 'frontmezzjunkies'),
    'a US outlet must still be filtered out of a West End roundup');
});

/**
 * isDualMarket regression (2026-09-15, Pre-Existing Condition incident).
 *
 * isDualMarket is a SEPARATE signal from region:'dual'. An outlet can carry a
 * single primary `region` (e.g. The Guardian: region:'london') while also
 * being isDualMarket:true to flag that it legitimately covers the other
 * market too. Before this fix, only `region` was read here, so an
 * isDualMarket:true outlet whose primary region wasn't already 'dual' was
 * still filtered out as non-local — confirmed live: The Guardian's real NYC
 * review in a BWW Review Roundup for "Pre-Existing Condition" was stripped
 * as "non-NYC" despite carrying isDualMarket:true. Mirrors
 * cross-market-guard.js's classifyReverseCrossMarket(), which already treats
 * isDualMarket as an unconditional "skip, legit by definition".
 */
test("precondition: guardian is still region:'london' + isDualMarket:true", () => {
  assert.equal(REGISTRY.guardian?.region, 'london');
  assert.equal(REGISTRY.guardian?.isDualMarket, true,
    'guardian was retagged — this is the fixture the isDualMarket regression tests below need');
});

test('isDualMarket outlet (guardian, region:london) is NOT filtered from a Broadway roundup', () => {
  const reviews = [
    { outletId: 'nytimes', excerpt: 'a Broadway review' },
    { outletId: 'variety', excerpt: 'another Broadway review' },
    { outletId: 'guardian', excerpt: 'a Guardian NYC review' },
  ];
  const result = validateBWWRoundupGeography(reviews, '', 'some-broadway-show-2026', false);
  assert.equal(result.length, 3, 'no review should be dropped');
  assert.ok(result.some(r => r.outletId === 'guardian'),
    'isDualMarket:true outlet must survive the Broadway geography filter regardless of its primary region');
});

test('isDualMarket outlet (guardian) is also NOT filtered from a West End roundup', () => {
  const reviews = [
    { outletId: 'thestage', excerpt: 'a London review' },
    { outletId: 'guardian', excerpt: 'a Guardian London review' },
  ];
  const result = validateBWWRoundupGeography(reviews, '', 'some-west-end-show-2026', true);
  assert.equal(result.length, 2, 'no review should be dropped');
});
