// Behaviour of the phone star row's show/hide decision (BRO-7074).
// Requires the real function (CLAUDE.md §15), no copied logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMobileStarRowState } from '../../src/lib/mobile-star-row';

const base = { showRateButton: true, hasRating: false, hasLocalRating: false, ratingStateKnown: true };

test('first rating on a seeable show shows the row', () => {
  assert.equal(getMobileStarRowState(base), 'visible');
});

test('announced show (no Rate it button) never gets the row, even while loading', () => {
  assert.equal(getMobileStarRowState({ ...base, showRateButton: false }), 'hidden');
  assert.equal(getMobileStarRowState({ ...base, showRateButton: false, ratingStateKnown: false }), 'hidden');
});

test('signed-in viewer who already rated: pending while loading, then hidden (no flash of a stale row)', () => {
  assert.equal(getMobileStarRowState({ ...base, ratingStateKnown: false }), 'pending');
  assert.equal(getMobileStarRowState({ ...base, hasRating: true }), 'hidden');
});

test('signed-out viewer with a rating saved on this device gets no "new rating" row', () => {
  assert.equal(getMobileStarRowState({ ...base, hasLocalRating: true }), 'hidden');
});

test('pending is never tappable: only "visible" exposes the row', () => {
  const states = [true, false].flatMap(known => [true, false].flatMap(rated =>
    getMobileStarRowState({ ...base, hasRating: rated, ratingStateKnown: known })));
  assert.deepEqual(states.filter(s => s === 'visible').length, 1);
});
