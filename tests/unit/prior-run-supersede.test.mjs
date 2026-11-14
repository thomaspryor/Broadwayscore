// BRO-4954: on a returning production, one review per outlet, newest wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { supersededPriorRunReviews, priorRunClassifier } = require('../../scripts/lib/prior-run-sibling.js');
const { broadcastReviewSubtitle } = require('../../scripts/lib/email-templates.js');

const bridge = { id: 'itw-bridge', title: 'Into the Woods', openingDate: '2025-12-11', closingDate: '2026-05-30', venue: 'Bridge Theatre' };
const transfer = {
  id: 'itw-nc', title: 'Into the Woods', previewsStartDate: '2026-09-22', openingDate: '2026-10-07', venue: 'Noel Coward Theatre',
  priorRuns: [{ id: 'itw-bridge', venue: 'Bridge Theatre', openingDate: '2025-12-11', closingDate: '2026-05-30' }],
};
const plain = { id: 'other', title: 'Other Show', openingDate: '2026-10-01' };
const shows = [bridge, transfer, plain];

const row = (showId, outletId, criticName, publishDate, extra = {}) => ({ showId, outletId, criticName, publishDate, assignedScore: 80, ...extra });

test('outlet that re-reviewed the transfer drops its carried earlier-run review (different critic)', () => {
  const oldTimes = row('itw-nc', 'times-uk', 'Clive Davis', '2025-12-12', { inheritedFromShowId: 'itw-bridge' });
  const newTimes = row('itw-nc', 'times-uk', 'Dominic Maxwell', '2026-10-08');
  const out = supersededPriorRunReviews([oldTimes, newTimes], shows);
  assert.deepEqual([...out], [oldTimes]);
});

test('earlier-run review filed on the transfer itself is superseded too', () => {
  const misfiled = row('itw-nc', 'thestage', 'A Critic', '2025-12-13');
  const fresh = row('itw-nc', 'thestage', 'Tom Wicker', '2026-10-08');
  assert.deepEqual([...supersededPriorRunReviews([misfiled, fresh], shows)], [misfiled]);
});

test('outlets that did not re-review keep their earlier-run review', () => {
  const guardian = row('itw-nc', 'guardian', 'Arifa Akbar', '2025-12-12', { inheritedFromShowId: 'itw-bridge' });
  const times = row('itw-nc', 'times-uk', 'Dominic Maxwell', '2026-10-08');
  assert.equal(supersededPriorRunReviews([guardian, times], shows).size, 0);
});

test('undated rows neither supersede nor get superseded', () => {
  const old = row('itw-nc', 'blog', 'X', '2025-12-20', { inheritedFromShowId: 'itw-bridge' });
  const undated = row('itw-nc', 'blog', 'Y', null);
  assert.equal(supersededPriorRunReviews([old, undated], shows).size, 0);
  const fresh = row('itw-nc', 'blog', 'Z', '2026-10-08');
  assert.deepEqual([...supersededPriorRunReviews([old, undated, fresh], shows)], [old]);
});

test('shows without priorRuns are untouched, and other shows do not interfere', () => {
  const a = row('other', 'times-uk', 'A', '2025-12-12');
  const b = row('other', 'times-uk', 'B', '2026-10-08');
  const bridgeOwn = row('itw-bridge', 'times-uk', 'Clive Davis', '2025-12-12');
  const nc = row('itw-nc', 'times-uk', 'Dominic Maxwell', '2026-10-08');
  assert.equal(supersededPriorRunReviews([a, b, bridgeOwn, nc], shows).size, 0);
});

test('classifier: prior windows, this run from its first preview, announcement-era pieces are neither', () => {
  const { isPrior, isCurrent } = priorRunClassifier(transfer, shows);
  assert.equal(isPrior({ publishDate: '2026-06-02' }), true); // inside the 7-day grace after the Bridge close
  assert.equal(isCurrent({ publishDate: '2026-06-02' }), false);
  assert.equal(isCurrent({ publishDate: '2026-09-25' }), true); // a preview review
  assert.equal(isCurrent({ publishDate: '2026-08-15' }), false); // after the close, before previews
  assert.equal(isPrior({ publishDate: '2026-08-15' }), false);
  assert.equal(isCurrent({ publishDate: '2026-10-08', inheritedFromShowId: 'itw-bridge' }), false);
  assert.equal(isCurrent({ publishDate: null }), false);
  assert.equal(isPrior({ publishDate: null }), false);
});

test('a tour closing the day before previews does not claim the opening reviews (grace overlap)', () => {
  const carMan = {
    id: 'car-man', title: 'The Car Man', previewsStartDate: '2026-07-28', openingDate: '2026-07-28',
    priorRuns: [{ venue: 'UK Tour', openingDate: '2026-06-15', closingDate: '2026-07-27' }],
  };
  const { isPrior, isCurrent } = priorRunClassifier(carMan, [carMan]);
  assert.equal(isCurrent({ publishDate: '2026-07-31' }), true);
  assert.equal(isPrior({ publishDate: '2026-07-31' }), false);
  const tour = row('car-man', 'british-theatre', 'A', '2026-07-22');
  const opening = row('car-man', 'british-theatre', 'B', '2026-08-03');
  assert.deepEqual([...supersededPriorRunReviews([tour, opening], [carMan])], [tour]);
  // the opening review is never the one dropped, even with a later follow-up from the same outlet
  const followUp = row('car-man', 'british-theatre', 'C', '2026-09-10');
  assert.deepEqual([...supersededPriorRunReviews([tour, opening, followUp], [carMan])], [tour]);
});

test('a pre-start piece from the same outlet does not supersede the earlier-run review', () => {
  const old = row('itw-nc', 'timeout', 'X', '2025-12-12', { inheritedFromShowId: 'itw-bridge' });
  const announcement = row('itw-nc', 'timeout', 'Y', '2026-08-15');
  assert.equal(supersededPriorRunReviews([old, announcement], shows).size, 0);
});

test('broadcast subtitle says how many reviews are new, only when some are carried', () => {
  assert.equal(broadcastReviewSubtitle(51, 19), '51 Critic Reviews (19 New)');
  assert.equal(broadcastReviewSubtitle(51, null), 'Based on 51 Critic Reviews');
  assert.equal(broadcastReviewSubtitle(12, 12), 'Based on 12 Critic Reviews');
  assert.equal(broadcastReviewSubtitle(1, undefined), 'Based on 1 Critic Review');
  assert.equal(broadcastReviewSubtitle(0, 0), 'Reviews pending');
  assert.ok(broadcastReviewSubtitle(51, 19).length <= 'Based on 51 Critic Reviews'.length);
});
