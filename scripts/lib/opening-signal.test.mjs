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
  MIN_REVIEWS_CURATED_HISTORICAL,
  T3_ONLY_EXTRA_REVIEWS,
  minReviewsForCategory,
  reviewsRemainingForScore,
  countByShow,
  estimatePressNight,
  isStuckInPreviews,
  chooseOpeningDateBackfill,
  findStuckPreviews,
} = require('./opening-signal.js');

// Deterministic clock for backfill tests: "today" is 2026-06-03.
const isReached = (d) => new Date(d) <= new Date('2026-06-03');

test('thresholds mirror src/config/score-buckets.ts MIN_REVIEWS_FOR_SCORE*', () => {
  assert.equal(MIN_REVIEWS_BY_CATEGORY.broadway, 5);
  assert.equal(MIN_REVIEWS_BY_CATEGORY['off-broadway'], 3);
  assert.equal(MIN_REVIEWS_BY_CATEGORY['west-end'], 5);
  assert.equal(MIN_REVIEWS_BY_CATEGORY['off-west-end'], 3);
  assert.equal(MIN_REVIEWS_CURATED_HISTORICAL, 4);
  assert.equal(T3_ONLY_EXTRA_REVIEWS, 2);
  assert.equal(minReviewsForCategory('off-broadway'), 3);
  assert.equal(minReviewsForCategory(undefined), 5, 'unknown category falls back to the strict default');
});

test('reviewsRemainingForScore ports the score-buckets.ts logic, incl. T3-only +2', () => {
  // Plain category thresholds (tier1And2 undefined → no T3 penalty).
  assert.equal(reviewsRemainingForScore(3, 'off-broadway', undefined, false), 0);
  assert.equal(reviewsRemainingForScore(2, 'off-broadway', undefined, false), 1);
  assert.equal(reviewsRemainingForScore(5, 'broadway', undefined, false), 0);

  // T3-only penalty: zero T1/T2 reviews raises the bar by 2.
  assert.equal(reviewsRemainingForScore(3, 'off-broadway', 0, false), 2, '3 T3-only OB reviews need 5, so 2 remain');
  assert.equal(reviewsRemainingForScore(5, 'off-broadway', 0, false), 0, '5 T3-only OB reviews qualify');
  assert.equal(reviewsRemainingForScore(3, 'off-broadway', 1, false), 0, 'one T1/T2 removes the penalty');

  // Curated-historical only lowers the Broadway bar to 4, and only with a T1/T2.
  assert.equal(reviewsRemainingForScore(4, 'broadway', 1, true), 0);
  assert.equal(reviewsRemainingForScore(4, 'broadway', 0, true), 3, 'no T1/T2 → no curated discount AND +2 penalty (4→7? no: min 5+2=7-4=3)');
});

test('countByShow tallies counts, T1/T2 tier counts, and valid dates', () => {
  const tierOf = (r) => ({ nytimes: 1, theatermania: 2, blog: 3 }[r.outletId]);
  const map = countByShow(
    [
      { showId: 'a', outletId: 'nytimes', publishDate: '2026-05-31' }, // T1
      { showId: 'a', outletId: 'theatermania', publishDate: '2026-06-01T09:00:00Z' }, // T2
      { showId: 'a', outletId: 'blog', date: 'not-a-date' }, // T3, bad date
      { showId: 'b', outletId: 'blog', publishDate: '2026-05-14' }, // T3
      { publishDate: '2026-05-14' }, // no showId — ignored
    ],
    tierOf,
  );
  assert.equal(map.a.count, 3);
  assert.equal(map.a.tier1And2, 2);
  assert.deepEqual(map.a.dates, ['2026-05-31', '2026-06-01']);
  assert.equal(map.b.count, 1);
  assert.equal(map.b.tier1And2, 0);
  // Without a tier resolver, tier1And2 stays 0 (no T3 penalty applied downstream
  // because callers pass the resolver; this only guards the optional-arg path).
  const noTier = countByShow([{ showId: 'c', outletId: 'nytimes', publishDate: '2026-05-01' }]);
  assert.equal(noTier.c.tier1And2, 0);
});

test('estimatePressNight returns the modal date, breaking ties to earliest', () => {
  assert.equal(
    estimatePressNight(['2026-05-14', '2026-05-14', '2026-05-14', '2026-05-14', '2026-05-15', '2026-05-21']),
    '2026-05-14',
  );
  assert.equal(estimatePressNight(['2026-06-01', '2026-05-31', '2026-06-01', '2026-05-31']), '2026-05-31');
  assert.equal(estimatePressNight(['2026-05-28', '2026-05-29', '2026-05-29']), '2026-05-29');
  assert.equal(estimatePressNight([]), null);
  assert.equal(estimatePressNight(['garbage', '']), null);
});

test('isStuckInPreviews fires only when the show would actually display a score', () => {
  // The three real incidents (all had T1/T2 coverage).
  assert.equal(isStuckInPreviews({ status: 'previews', category: 'off-broadway' }, { count: 4, tier1And2: 2 }), true); // small
  assert.equal(isStuckInPreviews({ status: 'previews', category: 'off-west-end' }, { count: 7, tier1And2: 3 }), true); // the-last-man
  assert.equal(isStuckInPreviews({ status: 'previews', category: 'off-broadway' }, { count: 5, tier1And2: 3 }), true); // rodeo

  // P1 regression: 3 T3-only OB reviews must NOT flip — the site still shows TBD
  // (needs 5), so flipping would label it "Now Playing" with a TBD score.
  assert.equal(isStuckInPreviews({ status: 'previews', category: 'off-broadway' }, { count: 3, tier1And2: 0 }), false);
  // …but the same show with 5 T3-only reviews DOES qualify.
  assert.equal(isStuckInPreviews({ status: 'previews', category: 'off-broadway' }, { count: 5, tier1And2: 0 }), true);

  // Below threshold during genuine previews — must NOT flip.
  assert.equal(isStuckInPreviews({ status: 'previews', category: 'off-broadway' }, { count: 2, tier1And2: 1 }), false);
  assert.equal(isStuckInPreviews({ status: 'previews', category: 'broadway' }, { count: 4, tier1And2: 2 }), false);

  // upcoming also counts as pre-open.
  assert.equal(isStuckInPreviews({ status: 'upcoming', category: 'broadway' }, { count: 5, tier1And2: 1 }), true);

  // Already-correct statuses, and missing entry, are never "stuck".
  assert.equal(isStuckInPreviews({ status: 'open', category: 'broadway' }, { count: 10, tier1And2: 5 }), false);
  assert.equal(isStuckInPreviews({ status: 'closed', category: 'broadway' }, { count: 10, tier1And2: 5 }), false);
  assert.equal(isStuckInPreviews({ status: 'previews', category: 'off-broadway' }, undefined), false);
  assert.equal(isStuckInPreviews(null, { count: 10, tier1And2: 5 }), false);
});

test('chooseOpeningDateBackfill derives openingDate from press night only, never fabricates', () => {
  // Normal case: review cluster present → press night (modal date).
  assert.deepEqual(
    chooseOpeningDateBackfill({ openingDate: null, previewsStartDate: '2026-05-01' }, ['2026-05-31', '2026-05-31', '2026-06-01'], isReached),
    { date: '2026-05-31', source: 'review-derived-press-night' },
  );
  // Every review dateless → null. We do NOT fabricate from previewsStartDate (that's
  // previews start, not opening; openingDate renders verbatim as "Opened {date}").
  // The status still flips; openingDate stays null (a tolerated state for open shows).
  assert.equal(chooseOpeningDateBackfill({ openingDate: null, previewsStartDate: '2026-05-01' }, [], isReached), null);
  // Dateless with no previewsStartDate → null.
  assert.equal(chooseOpeningDateBackfill({ openingDate: null }, [], isReached), null);
  // A future-only press night → null, never write the future date (Check 2c oscillation guard).
  assert.equal(chooseOpeningDateBackfill({ openingDate: null, previewsStartDate: '2026-05-01' }, ['2027-03-03'], isReached), null);
  // Never overwrite an existing openingDate.
  assert.equal(chooseOpeningDateBackfill({ openingDate: '2026-04-04', previewsStartDate: '2026-05-01' }, ['2026-05-31'], isReached), null);
});

test('findStuckPreviews surfaces stuck shows with press-night estimate, ignores healthy ones', () => {
  const shows = [
    { id: 'small', title: 'Small', category: 'off-broadway', status: 'previews', openingDate: null },
    { id: 'rodeo', title: 'Rodeo', category: 'off-broadway', status: 'previews', openingDate: null },
    { id: 't3-thin', title: 'Fringe', category: 'off-broadway', status: 'previews', openingDate: null },
    { id: 'open-show', title: 'Open', category: 'broadway', status: 'open', openingDate: '2026-04-01' },
  ];
  const countMap = {
    small: { count: 4, tier1And2: 2, dates: ['2026-05-29', '2026-05-29', '2026-06-01', '2026-05-31'] },
    rodeo: { count: 5, tier1And2: 3, dates: ['2026-06-01', '2026-06-01', '2026-05-31', '2026-06-01', '2026-06-01'] },
    't3-thin': { count: 3, tier1And2: 0, dates: ['2026-05-20', '2026-05-20', '2026-05-21'] }, // T3-only, below bar
    'open-show': { count: 12, tier1And2: 8, dates: ['2026-04-01'] },
  };
  const stuck = findStuckPreviews(shows, countMap);
  assert.equal(stuck.length, 2);
  const byId = Object.fromEntries(stuck.map((s) => [s.id, s]));
  assert.equal(byId.small.pressNight, '2026-05-29');
  assert.equal(byId.rodeo.pressNight, '2026-06-01');
  assert.equal(byId.small.reviewCount, 4);
  assert.ok(!byId['t3-thin'], 'T3-only show below the displayable bar is not flagged');
  assert.ok(!byId['open-show'], 'open show is not stuck');
});
