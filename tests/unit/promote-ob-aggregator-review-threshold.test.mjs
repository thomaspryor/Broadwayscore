// BRO-5573: the off-broadway aggregator branch must apply the BRO-125 3+
// distinct-review-outlet threshold, like decideRegionalPromotion does.
// Tests the REAL exported function (CLAUDE.md §15).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideOffBroadwayAggregatorPromotion } = require('../../scripts/promote-ob-venue-candidates.js');

const BASE = {
  title: 'A Serious Play', venue: 'Daryl Roth Theatre', slug: 'a-serious-play',
  source: 'bww-roundup',
  articlePublishedAt: '2026-08-01T10:00:00-04:00',
  discoveredAt: '2026-08-01T18:00:00.000Z',
  category: 'off-broadway',
};
const opts = { isKnownVenue: () => true, venueDirectoryAvailable: () => true };

test('OB roundup with 3 distinct review outlets confirms', () => {
  const r = decideOffBroadwayAggregatorPromotion({ ...BASE, reviewCount: 3 }, opts);
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'aggregator-roundup');
});

test('OB roundup with 1 or 2 review outlets does NOT confirm', () => {
  for (const n of [0, 1, 2]) {
    const r = decideOffBroadwayAggregatorPromotion({ ...BASE, reviewCount: n }, opts);
    assert.equal(r.confirmed, false, `reviewCount ${n}`);
    assert.match(r.reason, /needs 3\+/);
  }
});

test('OB roundup with missing or unparseable reviewCount fails closed', () => {
  for (const v of [undefined, null, NaN, '3']) {
    const r = decideOffBroadwayAggregatorPromotion({ ...BASE, reviewCount: v }, opts);
    assert.equal(r.confirmed, false, `reviewCount ${String(v)}`);
  }
});

// BRO-5793: below-threshold staged roundup rows must be re-fetched, not skipped.
const { shouldRefetchStaged, buildStagedUrlSkipSet } = require('../../scripts/lib/staged-refetch.js');
const NOW = Date.parse('2026-08-05T00:00:00Z');
const row = (o) => ({ ...BASE, sourceUrl: 'https://x/y', ...o });

test('refetch: recent roundup with reviewCount < 3 is re-fetched', () => {
  for (const source of ['bww-roundup', 'playbill-verdict']) {
    assert.equal(shouldRefetchStaged(row({ source, reviewCount: 2 }), { now: NOW }), true);
  }
  assert.equal(shouldRefetchStaged(row({ reviewCount: null }), { now: NOW }), true);
});

test('refetch: met threshold, old article, or non-roundup source is NOT re-fetched', () => {
  assert.equal(shouldRefetchStaged(row({ reviewCount: 3 }), { now: NOW }), false);
  assert.equal(shouldRefetchStaged(row({ reviewCount: 1, articlePublishedAt: '2026-06-01T00:00:00Z' }), { now: NOW }), false);
  assert.equal(shouldRefetchStaged(row({ reviewCount: 1, source: 'playbill-venue' }), { now: NOW }), false);
  assert.equal(shouldRefetchStaged(row({ reviewCount: 1, articlePublishedAt: null, discoveredAt: null }), { now: NOW }), false);
});

test('skip set excludes only re-fetchable rows', () => {
  const set = buildStagedUrlSkipSet([
    row({ sourceUrl: 'a', reviewCount: 1 }),
    row({ sourceUrl: 'b', reviewCount: 4 }),
    row({ sourceUrl: 'c', reviewCount: 1, source: 'other' }),
  ], { now: NOW });
  assert.deepEqual([...set].sort(), ['b', 'c']);
});
