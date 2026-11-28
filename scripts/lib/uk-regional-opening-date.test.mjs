import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reconcileOpeningDate, earliestReviewDate } = require('./uk-regional-opening-date.js');
const { isUnconfirmedDateSource } = require('./date-source-confidence.js');

const show = (over) => ({ openingDate: '2024-04-28', openingDateSource: 'guardian-review', category: 'regional', ...over });

test('moves a review-seeded date to the earliest review', () => {
  const d = reconcileOpeningDate(show(), ['2024-04-28', '2024-04-19', '2024-04-22']);
  assert.deepEqual([d.action, d.openingDate, d.openingDateSource, d.gapDays], ['move', '2024-04-19', 'first-review-date', 9]);
});
test('same-day or later reviews change nothing', () => {
  assert.equal(reconcileOpeningDate(show(), ['2024-04-28', '2024-05-02']).action, 'none');
});
test('month-only and null dates are ignored', () => {
  assert.equal(earliestReviewDate(['2025-03', null, undefined, '2025-03-04']), '2025-03-04');
  assert.equal(reconcileOpeningDate(show(), ['2024-04', null]).action, 'none');
});
test('census-review is treated like guardian-review', () => {
  assert.equal(reconcileOpeningDate(show({ openingDateSource: 'census-review' }), ['2024-04-27']).action, 'move');
});
test('a trusted source is reported, never moved', () => {
  const d = reconcileOpeningDate(show({ openingDateSource: 'manual' }), ['2024-04-27']);
  assert.equal(d.action, 'manual');
});
test('a gap over 14 days is reported, never moved', () => {
  const d = reconcileOpeningDate(show(), ['2024-04-01']);
  assert.equal(d.action, 'manual');
});
test('the new source stays overwritable by press-night sources', () => {
  for (const s of ['first-review-date', 'census-review', 'guardian-review']) assert.equal(isUnconfirmedDateSource({ category: 'regional', openingDateSource: s }), true);
});

test('BRO-7895: BroadwayWorld regional review seeds are reconciled with two early reviews', () => {
  const { regionalReconcileOptions } = require('./uk-regional-opening-date');
  const bww = show({ category: 'regional', discoverySource: 'bww-local-reviews', openingDateSource: 'bww-first-review', localOnly: true });
  const options = regionalReconcileOptions(bww, false, true);
  assert.deepEqual(options, { minReviews: 2 });
  assert.equal(reconcileOpeningDate(bww, ['2024-04-19', '2024-04-20'], options).openingDate, '2024-04-20');
  assert.equal(reconcileOpeningDate(bww, ['2024-04-19'], options).action, 'none');
  assert.equal(regionalReconcileOptions({ ...bww, humanCorrectedOpeningDate: true }, false, true), null);
  assert.equal(regionalReconcileOptions({ ...bww, category: 'broadway' }, false, true), null);
  assert.equal(isUnconfirmedDateSource(bww), true);
  const { distinctOutletDates } = require('./uk-regional-opening-date');
  const dates = distinctOutletDates([{ outletId: 'one', publishDate: '2024-04-19' }, { outletId: 'one', publishDate: '2024-04-20' }]);
  assert.equal(reconcileOpeningDate(bww, dates, options).action, 'none');
});
