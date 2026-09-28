/**
 * src/config/markets.json consistency invariant (BRO-4211).
 *
 * Why this test exists: a show category's base review threshold lived in three
 * switch statements (src/lib/market-utils.ts, src/config/score-buckets.ts,
 * scripts/lib/min-reviews.js) plus a label switch, and each silently falls back
 * to the Broadway default for an unknown category. Adding `tour` to one and not
 * the others would quietly give tours Broadway's threshold on some surfaces.
 * markets.json is now the table; this test fails when any switch drifts from it.
 *
 * Run: npx tsx --test tests/unit/markets-consistency.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMarketMinReviews, getMarketLabel } from '../../src/lib/market-utils';
import { reviewsRemainingForScore } from '../../src/config/score-buckets';
import { MARKETS as TS_MARKETS } from '../../src/lib/markets';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsMinReviews = require('../../scripts/lib/min-reviews');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsMarkets = require('../../scripts/lib/markets');

const rows = Object.entries(TS_MARKETS);

test('every category row has the fields the gates and switches read', () => {
  assert.ok(rows.length >= 6);
  for (const [category, row] of rows) {
    assert.equal(typeof row.label, 'string', category);
    assert.equal(typeof row.minReviews, 'number', category);
    assert.ok(row.featureFlag === null || typeof row.featureFlag === 'string', category);
    assert.equal(typeof row.hideFromAppFeed, 'boolean', category);
  }
});

test('all three min-review switches agree with markets.json', () => {
  for (const [category, row] of rows) {
    assert.equal(getMarketMinReviews(category), row.minReviews, `market-utils ${category}`);
    assert.equal(jsMinReviews.getMarketMinReviews(category), row.minReviews, `min-reviews.js ${category}`);
    // score-buckets: 0 T3-only extra when a T1/T2 review exists, so remaining at 0 reviews = base threshold.
    assert.equal(reviewsRemainingForScore(0, category, 1), row.minReviews, `score-buckets ${category}`);
  }
});

test('getMarketLabel agrees with markets.json', () => {
  for (const [category, row] of rows) {
    assert.equal(getMarketLabel(category), row.label, category);
  }
});

test('script-side reader exposes the same categories', () => {
  assert.deepEqual([...jsMarkets.VALID_CATEGORIES].sort(), rows.map(([c]) => c).sort());
});

test('flag gate: tour hidden and withheld from the app feed until NEXT_PUBLIC_FEATURES has tour', () => {
  assert.equal(jsMarkets.isCategoryEnabled('tour', ''), false);
  assert.equal(jsMarkets.isHiddenFromAppFeed('tour', ''), true);
  assert.equal(jsMarkets.isCategoryEnabled('tour', 'regional,tour'), true);
  assert.equal(jsMarkets.isHiddenFromAppFeed('tour', 'tour'), false);
  // regional predates the app-feed gate and stays in the feed either way.
  assert.equal(jsMarkets.isCategoryEnabled('regional', ''), false);
  assert.equal(jsMarkets.isHiddenFromAppFeed('regional', ''), false);
  // Categories without a flag are never hidden; unknown categories are not hidden.
  assert.equal(jsMarkets.isCategoryEnabled('broadway', ''), true);
  assert.equal(jsMarkets.isHiddenFromAppFeed('broadway', ''), false);
  assert.equal(jsMarkets.isCategoryEnabled(undefined, ''), true);
});
