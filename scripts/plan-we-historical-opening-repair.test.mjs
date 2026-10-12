import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rowActions, sourcedPressNights, SOURCED } = require('./plan-we-historical-opening-repair.js');

const show = { id: 'betrayal-west-end-2019', discoverySource: 'we-historical:wos', previewsStartDate: null, openingDate: '2019-03-05', openingDateSource: 'whatsonstage' };
const rv = (...d) => d.map((publishDate) => ({ publishDate }));

test('a sourced press night beats the review inference', () => {
  const sourced = sourcedPressNights({ 'betrayal-west-end-2019|openingNight': { verdict: 'wrong', correctValue: '2019-03-13', url: 'https://x/betrayal', note: 'opening=first-preview' } });
  const a = rowActions(show, rv('2019-03-15', '2019-03-15', '2019-03-15'), sourced);
  assert.deepEqual(a.map((x) => [x.field, x.newValue]), [['previewsStartDate', '2019-03-05'], ['openingDate', '2019-03-13'], ['openingDateSource', SOURCED]]);
});

test('a stored opening checked correct is left alone', () => {
  const sourced = sourcedPressNights({ 'betrayal-west-end-2019|openingNight': { verdict: 'correct', url: 'https://x' } });
  assert.deepEqual(rowActions(show, rv('2019-03-15', '2019-03-15', '2019-03-15'), sourced), []);
});

test('changing the opening date re-keys an active no-reliable-art marker', () => {
  const marked = { ...show, title: 'Betrayal', venue: 'Harold Pinter Theatre', noReliableArt: { at: '2026-10-11', reason: 'r', key: 'betrayal|harold pinter theatre|2019-03-05' } };
  const a = rowActions(marked, rv('2019-03-14', '2019-03-14', '2019-03-14'), new Map());
  const m = a.find((x) => x.field === 'noReliableArt');
  assert.equal(m.newValue.key, 'betrayal|harold pinter theatre|2019-03-13');
  assert.equal(m.newValue.at, '2026-10-11');
});

test('the review-mode source can be overwritten by an authoritative source but is never re-inferred', () => {
  const { isUnconfirmedDateSource } = require('./lib/date-source-confidence.js');
  const { inferPressNightFromReviews } = require('./lib/infer-press-night-from-reviews.js');
  const row = { id: 'x', category: 'west-end', previewsStartDate: '2019-10-01', openingDate: '2019-10-08', openingDateSource: 'inferred-from-reviews-mode' };
  assert.equal(isUnconfirmedDateSource(row), true);
  const reviews = ['2019-10-30', '2019-10-30', '2019-10-31'].map((publishDate) => ({ showId: 'x', publishDate }));
  assert.deepEqual(inferPressNightFromReviews({ candidateShows: [row], reviews }), []);
});
