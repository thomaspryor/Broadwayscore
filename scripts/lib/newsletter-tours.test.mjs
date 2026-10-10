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

test('window runs from the day before weekStart through weekEnd, inclusive', () => {
  assert.equal(pickNewlyScoredTours(shows, stamps, '2026-10-04', '2026-10-04').length, 1);
  assert.equal(pickNewlyScoredTours(shows, stamps, '2026-09-29', '2026-09-29')[0].id, 'wicked-tour-2021');
  // Sunday 2026-10-04 stamp, after the Sunday refresh: next Monday's issue gets it.
  assert.deepEqual(pickNewlyScoredTours(shows, stamps, '2026-10-05', '2026-10-11').map(s => s.id), ['jersey-boys-tour-2026']);
  assert.equal(pickNewlyScoredTours(shows, stamps, '2026-10-06', '2026-10-11').length, 0);
});

test('excludeIds drops a tour the previous issue already featured', () => {
  const ids = pickNewlyScoredTours(shows, stamps, '2026-10-05', '2026-10-11', { excludeIds: new Set(['jersey-boys-tour-2026']) });
  assert.deepEqual(ids, []);
});

test('reviews: an old tour stamped by a data catch-up is not news', () => {
  const reviews = [
    { showId: 'jersey-boys-tour-2026', assignedScore: 80, publishDate: '2026-09-20' },
    { showId: 'jersey-boys-tour-2026', assignedScore: null, publishDate: '2026-10-01' },
    { showId: 'wicked-tour-2021', assignedScore: 85, publishDate: '2021-08-08' },
  ];
  const all = pickNewlyScoredTours(shows, stamps, '2026-09-28', '2026-10-04', { reviews }).map(s => s.id);
  assert.deepEqual(all, ['jersey-boys-tour-2026']);
  // Newest scored review 61 days before weekEnd: too old. 60 days: still in.
  const edge = (d) => pickNewlyScoredTours(shows, stamps, '2026-10-03', '2026-10-09',
    { reviews: [{ showId: 'jersey-boys-tour-2026', assignedScore: 70, publishDate: d }] }).length;
  assert.equal(edge('2026-08-10'), 1);
  assert.equal(edge('2026-08-09'), 0);
  // No dated scored review at all (the-lion-king-tour-2021 has none).
  assert.equal(pickNewlyScoredTours(shows, stamps, '2026-10-03', '2026-10-09', { reviews: [] }).length, 0);
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
