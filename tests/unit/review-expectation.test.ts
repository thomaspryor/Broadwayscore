// Owner decision 2026-10-14: long-closed one-off events with no reviews say
// "No critic reviews expected" instead of counting down to a CriticScore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { noCriticReviewsExpected, NO_REVIEWS_AFTER_DAYS } from '../../src/lib/review-expectation';

const NOW = new Date('2026-10-14T12:00:00Z');
const event = { type: 'special', status: 'closed', category: 'off-broadway', closingDate: '2026-08-16' };

test('a one-night event closed two months ago with no reviews expects none', () => {
  assert.equal(noCriticReviewsExpected(event, 0, NOW), true);
});

test('any review on file keeps the normal countdown', () => {
  assert.equal(noCriticReviewsExpected(event, 1, NOW), false);
});

test('a closing date carrying a time still parses', () => {
  assert.equal(noCriticReviewsExpected({ ...event, closingDate: '2026-08-16T19:30' }, 0, NOW), true);
});

test('recently closed events can still be reviewed', () => {
  assert.equal(noCriticReviewsExpected({ ...event, closingDate: '2026-10-10' }, 0, NOW), false);
  const edge = new Date(Date.parse('2026-08-16T00:00:00Z') + NO_REVIEWS_AFTER_DAYS * 864e5);
  assert.equal(noCriticReviewsExpected(event, 0, edge), true);
});

test('plays, musicals, Broadway specials, open runs and missing dates keep the old wording', () => {
  assert.equal(noCriticReviewsExpected({ ...event, type: 'play' }, 0, NOW), false);
  assert.equal(noCriticReviewsExpected({ ...event, type: 'musical' }, 0, NOW), false);
  assert.equal(noCriticReviewsExpected({ ...event, type: 'opera' }, 0, NOW), true, 'one-night opera galas count');
  assert.equal(noCriticReviewsExpected({ ...event, category: 'broadway' }, 0, NOW), false);
  assert.equal(noCriticReviewsExpected({ ...event, status: 'open' }, 0, NOW), false);
  assert.equal(noCriticReviewsExpected({ ...event, closingDate: null }, 0, NOW), false);
  assert.equal(noCriticReviewsExpected({ ...event, category: null }, 0, NOW), false);
});
