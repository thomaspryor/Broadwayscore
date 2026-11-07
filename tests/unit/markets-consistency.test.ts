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
import { featureFlags } from '../../src/config/feature-flags';
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

test('every featureFlag in markets.json names a real featureFlags getter', () => {
  // A typo here would fail closed: the category stays hidden even with the env flag on.
  for (const [category, row] of rows) {
    if (row.featureFlag) {
      const desc = Object.getOwnPropertyDescriptor(featureFlags, row.featureFlag);
      assert.ok(desc && typeof desc.get === 'function', `${category}: featureFlags.${row.featureFlag} does not exist`);
    }
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

test('tour: launched on the web in code, still withheld from the app feed until the env flag (BRO-4211, BRO-4254)', () => {
  assert.equal(jsMarkets.isCategoryEnabled('tour', ''), true);
  assert.equal(jsMarkets.isHiddenFromAppFeed('tour', ''), true);
  assert.equal(jsMarkets.isHiddenFromAppFeed('tour', 'regional,tour'), false);
  assert.equal(featureFlags.tour, true);
  // regional is not launched: the env gate still decides it.
  assert.equal(jsMarkets.isCategoryEnabled('regional', ''), false);
  assert.equal(jsMarkets.isCategoryEnabled('regional', 'regional'), true);
  assert.equal(jsMarkets.isHiddenFromAppFeed('regional', ''), false);
});

test('launched in markets.json exactly when the featureFlags getter is hard-wired true', () => {
  // Web (featureFlags) and script (markets.js) gates must agree with no env set.
  for (const [category, row] of Object.entries(TS_MARKETS) as [string, any][]) {
    if (!row.featureFlag) continue;
    const webOn = (featureFlags as unknown as Record<string, boolean>)[row.featureFlag] === true;
    assert.equal(jsMarkets.isCategoryEnabled(category, ''), webOn, category);
    assert.equal(row.launched === true, webOn, category);
  }
});

test('unflagged categories are always public and in the app feed', () => {
  for (const c of ['broadway', 'off-broadway', 'west-end', 'off-west-end', undefined]) {
    assert.equal(jsMarkets.isCategoryEnabled(c, ''), true, String(c));
    assert.equal(jsMarkets.isHiddenFromAppFeed(c, ''), false, String(c));
  }
});

test('per-show files: regional stays published with no env flags; tours too; nothing else changes (BRO-4262 ship-check)', () => {
  for (const c of ['broadway', 'off-broadway', 'west-end', 'off-west-end', 'regional', 'tour', undefined]) {
    assert.equal(jsMarkets.isPublishedShowFile(c, ''), true, String(c));
  }
});
