/**
 * ratingsHistogram — the half-star distribution and its footer counts.
 *
 * Runs the REAL src/lib/stats/ratings-histogram.ts. The contract that matters:
 * null-rated entries count toward `total` (that's the "186 of 195 shows rated"
 * footer) but never enter a bucket and never move the average.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ratingBuckets, ratingsHistogram } from '../../src/lib/stats/ratings-histogram';

const row = (show_id, rating) => ({ show_id, rating, date_seen: '2026-01-01' });

test('there are always ten buckets, 0.5 to 5.0, even with no data', () => {
  assert.deepEqual(ratingBuckets(), [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
  const h = ratingsHistogram([]);
  assert.equal(h.buckets.length, 10);
  assert.deepEqual(h.buckets.map((b) => b.value), ratingBuckets());
  assert.equal(h.buckets.every((b) => b.count === 0 && b.share === 0), true);
  assert.equal(h.total, 0);
  assert.equal(h.average, null);
  assert.equal(h.median, null);
  assert.equal(h.mode, null);
});

test('RATING STRINGS: "4.0" lands in the 4.0 bucket', () => {
  const h = ratingsHistogram([row('a', '4.0'), row('b', '3.5'), row('c', 4)]);
  assert.equal(h.buckets.find((b) => b.value === 4).count, 2);
  assert.equal(h.buckets.find((b) => b.value === 3.5).count, 1);
  assert.equal(h.rated, 3);
});

test('NULL RATINGS: counted in total, excluded from buckets and the average', () => {
  const h = ratingsHistogram([
    row('a', '4.0'),
    row('b', null),
    row('c', ''),
    row('d', 'garbage'),
    row('e', '2.0'),
  ]);
  assert.equal(h.total, 5);
  assert.equal(h.rated, 2);
  assert.equal(h.unrated, 3);
  assert.equal(h.buckets.reduce((n, b) => n + b.count, 0), 2, 'only rated rows are bucketed');
  assert.equal(h.average, 3, 'mean of 4 and 2 — the nulls are not zeros');
  assert.deepEqual(h.unratedShowIds, ['b', 'c', 'd']);
});

test('shares are computed against RATED, not total', () => {
  const h = ratingsHistogram([row('a', '5.0'), row('b', '5.0'), row('c', null)]);
  assert.equal(h.buckets.find((b) => b.value === 5).share, 1);
});

test('average, median and mode', () => {
  const h = ratingsHistogram([
    row('a', '2.0'),
    row('b', '4.0'),
    row('c', '4.0'),
    row('d', '5.0'),
  ]);
  assert.equal(h.average, 3.75);
  assert.equal(h.median, 4, 'even count: mean of the two middles, 4 and 4');
  assert.equal(h.mode, 4);
});

test('median of an odd count is the middle value', () => {
  const h = ratingsHistogram([row('a', '1.0'), row('b', '4.5'), row('c', '5.0')]);
  assert.equal(h.median, 4.5);
});

test('off-grid and out-of-range ratings snap into a legal bucket', () => {
  const h = ratingsHistogram([row('a', '3.7'), row('b', '9'), row('c', '0.2')]);
  assert.equal(h.rated, 3);
  assert.equal(h.buckets.find((b) => b.value === 3.5).count, 1);
  assert.equal(h.buckets.find((b) => b.value === 5).count, 1);
  assert.equal(h.buckets.find((b) => b.value === 0.5).count, 1);
  // Nothing escaped the ten legal buckets.
  assert.equal(h.buckets.reduce((n, b) => n + b.count, 0), 3);
});

test('a zero rating is unrated, not a 0-star review', () => {
  const h = ratingsHistogram([row('a', '0'), row('b', 0)]);
  assert.equal(h.rated, 0);
  assert.equal(h.unrated, 2);
  assert.equal(h.average, null);
});

test('bucket values carry no floating-point dust', () => {
  const h = ratingsHistogram([row('a', '1.5')]);
  for (const b of h.buckets) {
    assert.equal(b.value, Math.round(b.value * 2) / 2, `${b.value} is off the half-star grid`);
  }
  assert.equal(h.buckets.find((b) => b.value === 1.5).count, 1);
});
