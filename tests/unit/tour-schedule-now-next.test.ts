/**
 * Tour schedule helpers behind the "Now in / Next" card line, the Tour
 * Schedule card and the reviews "By City" sort (BRO-4601). Calls the real
 * exported functions (CLAUDE.md rule 15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getTourNowNext, stopForReview, shortCity, stopKey, type TourStop } from '../../src/lib/tour-schedule';

const require = createRequire(import.meta.url);
const { tourStops } = require('../../scripts/fetch-tour-schedules.js');

const stops: TourStop[] = [
  { city: 'Hartford, CT', venue: 'The Bushnell', start: '2026-09-19', end: '2026-09-23' },
  { city: 'San Diego, CA', venue: 'Civic Theatre', start: '2026-09-29', end: '2026-10-04' },
  { city: 'Las Vegas, NV', venue: 'Smith Center', start: '2026-10-06', end: '2026-10-11' },
];

test('now is the engagement running today, inclusive of both ends', () => {
  assert.equal(getTourNowNext(stops, '2026-10-04').now?.city, 'San Diego, CA');
  assert.equal(getTourNowNext(stops, '2026-09-29').now?.city, 'San Diego, CA');
  assert.equal(getTourNowNext(stops, '2026-10-04').next?.city, 'Las Vegas, NV');
});

test('between stops there is no now, only next; after the last there is neither', () => {
  assert.deepEqual(getTourNowNext(stops, '2026-09-25'), { now: null, next: stops[1] });
  assert.deepEqual(getTourNowNext(stops, '2026-12-01'), { now: null, next: null });
});

test('a review is filed under the stop playing on its publish date', () => {
  assert.equal(stopForReview(stops, '2026-10-01')?.city, 'San Diego, CA');
  // A closing-weekend review published up to 3 days after the stop ended.
  assert.equal(stopForReview(stops, '2026-09-25')?.city, 'Hartford, CT');
  // Gap past the grace window: the latest stop that had started.
  assert.equal(stopForReview(stops, '2026-09-28')?.city, 'Hartford, CT');
  assert.equal(stopForReview(stops, '2026-09-01'), null);
  assert.equal(stopForReview(stops, null), null);
});

test('shortCity drops the state; stopKey separates two visits to one city', () => {
  assert.equal(shortCity('San Diego, CA'), 'San Diego');
  assert.equal(shortCity('Washington, DC'), 'Washington');
  assert.notEqual(stopKey({ ...stops[0], start: '2027-01-01' }), stopKey(stops[0]));
});

test('tourStops picks the segment matching the tour launch from a Tours To You table', () => {
  const row = (city: string, venue: string, dates: string) => `<tr><td>${city}</td><td>${venue}</td><td>${dates}</td></tr>`;
  const html = `<table>${[
    row('Boston, MA', 'Opera House', 'March 1-12, 2024'),
    row('Chicago, IL', 'CIBC Theatre', 'March 14-24, 2024'),
    row('Hartford, CT', 'The Bushnell', 'September 19-23, 2026'),
    row('San Diego, CA', 'Civic Theatre', 'September 29-October 4, 2026'),
  ].join('')}</table>`;
  const got = tourStops({ id: 'x-tour-2026', openingDate: '2026-09-19' }, html);
  assert.deepEqual(got.map((s: TourStop) => s.city), ['Hartford, CT', 'San Diego, CA']);
  assert.equal(got[1].end, '2026-10-04');
  assert.equal(tourStops({ id: 'x-tour-2026', openingDate: '2026-09-19' }, ''), null);
});
