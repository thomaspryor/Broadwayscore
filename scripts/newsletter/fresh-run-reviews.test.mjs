import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasFreshRunReview, freshCutoffFor, FRESH_GRACE_DAYS } from './fresh-run-reviews.mjs';

// Tier resolver stand-in: outlet id encodes its tier so each case reads plainly.
const tierOf = (id) => ({ t1: 1, t2: 2, t3: 3, t4: 4 }[id] ?? 3);

// The real incident: My Son's A Queer (But What Can You Do?), Apollo 2026,
// priorRuns = Garrick 2022, every scored review dated 2022-10-24.
const MY_SONS = {
  previewsStartDate: '2026-09-16',
  openingDate: '2026-09-17',
  priorRuns: [{ openingDate: '2022-10-21', venue: 'Garrick Theatre' }],
};
const GARRICK_REVIEWS = [
  { outletId: 't1', assignedScore: 82, publishDate: '2022-10-24' },
  { outletId: 't1', assignedScore: 74, publishDate: '2022-10-24' },
  { outletId: 't2', assignedScore: 60, publishDate: '2022-10-24' },
  { outletId: 't3', assignedScore: 97, publishDate: '2022-10-24' },
];

test('freshCutoffFor anchors on previewsStartDate minus the grace window', () => {
  assert.equal(freshCutoffFor(MY_SONS), '2026-09-09');
  assert.equal(FRESH_GRACE_DAYS, 7);
});

test('freshCutoffFor falls back to openingDate when previews are unknown', () => {
  assert.equal(freshCutoffFor({ openingDate: '2026-09-17' }), '2026-09-10');
});

test('freshCutoffFor: no usable date -> null', () => {
  assert.equal(freshCutoffFor({}), null);
  assert.equal(freshCutoffFor(null), null);
});

test('the real incident: priorRuns show with only prior-run reviews is BLOCKED', () => {
  assert.equal(hasFreshRunReview(MY_SONS, GARRICK_REVIEWS, tierOf), false);
});

test('one fresh T1 review against the current run unblocks it', () => {
  const reviews = [...GARRICK_REVIEWS, { outletId: 't1', assignedScore: 88, publishDate: '2026-09-18' }];
  assert.equal(hasFreshRunReview(MY_SONS, reviews, tierOf), true);
});

test('a fresh T2 also unblocks it', () => {
  const reviews = [...GARRICK_REVIEWS, { outletId: 't2', assignedScore: 71, publishDate: '2026-09-18' }];
  assert.equal(hasFreshRunReview(MY_SONS, reviews, tierOf), true);
});

test('a fresh T3/T4 blog notice is NOT enough', () => {
  const reviews = [
    ...GARRICK_REVIEWS,
    { outletId: 't3', assignedScore: 90, publishDate: '2026-09-18' },
    { outletId: 't4', assignedScore: 95, publishDate: '2026-09-18' },
  ];
  assert.equal(hasFreshRunReview(MY_SONS, reviews, tierOf), false);
});

test('a fresh T1 that is UNSCORED does not count', () => {
  const reviews = [...GARRICK_REVIEWS, { outletId: 't1', assignedScore: null, publishDate: '2026-09-18' }];
  assert.equal(hasFreshRunReview(MY_SONS, reviews, tierOf), false);
});

test('an early-but-in-window T1 (embargo break, 3 days before previews) counts', () => {
  const reviews = [...GARRICK_REVIEWS, { outletId: 't1', assignedScore: 80, publishDate: '2026-09-13' }];
  assert.equal(hasFreshRunReview(MY_SONS, reviews, tierOf), true);
});

test('a T1 just OUTSIDE the grace window does not count', () => {
  const reviews = [...GARRICK_REVIEWS, { outletId: 't1', assignedScore: 80, publishDate: '2026-09-08' }];
  assert.equal(hasFreshRunReview(MY_SONS, reviews, tierOf), false);
});

// Fail-open cases — the gate must never drop an ordinary opening.
test('a show with NO priorRuns always passes, whatever its review dates', () => {
  const ordinary = { previewsStartDate: '2026-09-16', openingDate: '2026-09-17' };
  assert.equal(hasFreshRunReview(ordinary, GARRICK_REVIEWS, tierOf), true);
  assert.equal(hasFreshRunReview(ordinary, [], tierOf), true);
});

test('priorRuns present but empty array is treated as no priorRuns', () => {
  assert.equal(hasFreshRunReview({ ...MY_SONS, priorRuns: [] }, GARRICK_REVIEWS, tierOf), true);
});

test('a priorRuns show with no usable date fails OPEN rather than being dropped', () => {
  const undated = { priorRuns: [{ openingDate: '2022-10-21' }] };
  assert.equal(hasFreshRunReview(undated, GARRICK_REVIEWS, tierOf), true);
});

test('missing show / missing reviews are handled', () => {
  assert.equal(hasFreshRunReview(null, [], tierOf), false);
  assert.equal(hasFreshRunReview(MY_SONS, undefined, tierOf), false);
  assert.equal(hasFreshRunReview(MY_SONS, [null, {}], tierOf), false);
});
