// Tests for opening-signal.js — the review-driven "this show has opened" signal
// that backstops update-show-status.js Check 2d. No network, pure fixtures.
//
// Regression target: rodeo / the-last-man / small (2026-06) sat in `previews`
// with null openingDate + no ShowScore URL, so the date- and ShowScore-based
// flips never fired and their scores were suppressed by the showTBD gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MIN_REVIEWS_BY_CATEGORY,
  minReviewsForScore,
  countByShow,
  estimatePressNight,
  isStuckInPreviews,
  findStuckPreviews,
} = require('./opening-signal.js');

test('thresholds mirror src/config/score-buckets.ts MIN_REVIEWS_FOR_SCORE*', () => {
  assert.equal(MIN_REVIEWS_BY_CATEGORY.broadway, 5);
  assert.equal(MIN_REVIEWS_BY_CATEGORY['off-broadway'], 3);
  assert.equal(MIN_REVIEWS_BY_CATEGORY['west-end'], 5);
  assert.equal(MIN_REVIEWS_BY_CATEGORY['off-west-end'], 3);
  assert.equal(minReviewsForScore('off-broadway'), 3);
  assert.equal(minReviewsForScore(undefined), 5, 'unknown category falls back to the strict default');
});

test('countByShow tallies per-show counts and collects valid dates', () => {
  const map = countByShow([
    { showId: 'a', publishDate: '2026-05-31' },
    { showId: 'a', publishDate: '2026-06-01T09:00:00Z' },
    { showId: 'a', date: 'not-a-date' },
    { showId: 'b', publishDate: '2026-05-14' },
    { publishDate: '2026-05-14' }, // no showId — ignored
  ]);
  assert.equal(map.a.count, 3);
  assert.deepEqual(map.a.dates, ['2026-05-31', '2026-06-01']);
  assert.equal(map.b.count, 1);
  assert.equal(map['undefined'], undefined);
});

test('estimatePressNight returns the modal date, breaking ties to earliest', () => {
  // the-last-man cluster: 4 outlets on 05-14 is the clear mode.
  assert.equal(
    estimatePressNight(['2026-05-14', '2026-05-14', '2026-05-14', '2026-05-14', '2026-05-15', '2026-05-21']),
    '2026-05-14',
  );
  // Tie between two dates → earliest wins.
  assert.equal(estimatePressNight(['2026-06-01', '2026-05-31', '2026-06-01', '2026-05-31']), '2026-05-31');
  // A single early outlet (e.g. Talkin' Broadway pre-opening) must not beat the cluster.
  assert.equal(estimatePressNight(['2026-05-28', '2026-05-29', '2026-05-29']), '2026-05-29');
  assert.equal(estimatePressNight([]), null);
  assert.equal(estimatePressNight(['garbage', '']), null);
});

test('isStuckInPreviews fires only for pre-open status past the category threshold', () => {
  // The three real incidents.
  assert.equal(isStuckInPreviews({ status: 'previews', category: 'off-broadway' }, 4), true); // small
  assert.equal(isStuckInPreviews({ status: 'previews', category: 'off-west-end' }, 7), true); // the-last-man
  assert.equal(isStuckInPreviews({ status: 'previews', category: 'off-broadway' }, 5), true); // rodeo

  // Below threshold: a couple of early reviews during genuine previews — must NOT flip.
  assert.equal(isStuckInPreviews({ status: 'previews', category: 'off-broadway' }, 2), false);
  assert.equal(isStuckInPreviews({ status: 'previews', category: 'broadway' }, 4), false);

  // upcoming also counts as a pre-open status.
  assert.equal(isStuckInPreviews({ status: 'upcoming', category: 'broadway' }, 5), true);

  // Already-correct statuses are never "stuck".
  assert.equal(isStuckInPreviews({ status: 'open', category: 'broadway' }, 10), false);
  assert.equal(isStuckInPreviews({ status: 'closed', category: 'broadway' }, 10), false);
  assert.equal(isStuckInPreviews(null, 10), false);
});

test('findStuckPreviews surfaces stuck shows with press-night estimate, ignores healthy ones', () => {
  const shows = [
    { id: 'small', title: 'Small', category: 'off-broadway', status: 'previews', openingDate: null },
    { id: 'rodeo', title: 'Rodeo', category: 'off-broadway', status: 'previews', openingDate: null },
    { id: 'open-show', title: 'Open', category: 'broadway', status: 'open', openingDate: '2026-04-01' },
    { id: 'true-previews', title: 'Early', category: 'broadway', status: 'previews', openingDate: '2026-07-01' },
  ];
  const countMap = {
    small: { count: 4, dates: ['2026-05-29', '2026-05-29', '2026-06-01', '2026-05-31'] },
    rodeo: { count: 5, dates: ['2026-06-01', '2026-06-01', '2026-05-31', '2026-06-01', '2026-06-01'] },
    'open-show': { count: 12, dates: ['2026-04-01'] },
    'true-previews': { count: 1, dates: ['2026-06-30'] }, // one early review, below threshold
  };
  const stuck = findStuckPreviews(shows, countMap);
  assert.equal(stuck.length, 2);
  const byId = Object.fromEntries(stuck.map((s) => [s.id, s]));
  assert.equal(byId.small.pressNight, '2026-05-29');
  assert.equal(byId.rodeo.pressNight, '2026-06-01');
  assert.equal(byId.small.reviewCount, 4);
  assert.ok(!byId['open-show'], 'open show is not stuck');
  assert.ok(!byId['true-previews'], 'genuine previews with one early review is not stuck');
});
