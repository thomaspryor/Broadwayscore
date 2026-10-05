import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickNewlyScoredTours, tourWhereLine } = require('./newsletter-tours.js');

const shows = [
  { id: 'jersey-boys-tour-2026', category: 'tour', status: 'open' },
  { id: 'wicked-tour-2021', category: 'tour', status: 'open' },
  { id: 'old-tour-2019', category: 'tour', status: 'closed' },
  { id: 'hamilton-2015', category: 'broadway', status: 'open' },
  { id: 'unscored-tour-2026', category: 'tour', status: 'open' },
];
const stamps = {
  'jersey-boys-tour-2026': '2026-10-04T10:37:05.518Z',
  'wicked-tour-2021': '2026-09-29T00:37:37.754Z',
  'old-tour-2019': '2026-10-05T01:00:00.000Z',
  'hamilton-2015': '2026-10-05T01:00:00.000Z',
};

test('picks open tours whose score went public in the week', () => {
  const ids = pickNewlyScoredTours(shows, stamps, '2026-10-03', '2026-10-09').map(s => s.id);
  assert.deepEqual(ids, ['jersey-boys-tour-2026']);
});

test('week bounds are inclusive on the stamp date', () => {
  assert.equal(pickNewlyScoredTours(shows, stamps, '2026-10-04', '2026-10-04').length, 1);
  assert.equal(pickNewlyScoredTours(shows, stamps, '2026-09-29', '2026-09-29')[0].id, 'wicked-tour-2021');
  assert.equal(pickNewlyScoredTours(shows, stamps, '2026-10-05', '2026-10-09').length, 0);
});

test('missing or malformed stamps file picks nothing', () => {
  assert.deepEqual(pickNewlyScoredTours(shows, null, '2026-10-03', '2026-10-09'), []);
  assert.deepEqual(pickNewlyScoredTours(shows, { 'jersey-boys-tour-2026': 123 }, '2026-10-03', '2026-10-09'), []);
});

const stops = [
  { city: 'Chicago, IL', start: '2026-10-01', end: '2026-10-11' },
  { city: 'Denver, CO', start: '2026-10-14', end: '2026-10-25' },
];

test('tourWhereLine: playing now, between stops, finished, no schedule', () => {
  assert.equal(tourWhereLine(stops, '2026-10-05'), 'Now in Chicago');
  assert.equal(tourWhereLine(stops, '2026-10-11'), 'Now in Chicago');
  assert.equal(tourWhereLine(stops, '2026-10-12'), 'Next: Denver');
  assert.equal(tourWhereLine(stops, '2026-11-01'), null);
  assert.equal(tourWhereLine(undefined, '2026-10-05'), null);
});
