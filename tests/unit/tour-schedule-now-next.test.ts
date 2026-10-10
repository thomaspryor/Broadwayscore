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

test('an opening-night review goes to the new city, not the one that just closed', () => {
  // San Diego closes Oct 4, Las Vegas opens Oct 6: Oct 7 is inside San Diego's
  // grace window but Las Vegas is playing.
  assert.equal(stopForReview(stops, '2026-10-07')?.city, 'Las Vegas, NV');
  assert.equal(stopForReview(stops, '2026-10-06')?.city, 'Las Vegas, NV');
  // Oct 5, between the two: the closing-weekend review stays in San Diego.
  assert.equal(stopForReview(stops, '2026-10-05')?.city, 'San Diego, CA');
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

test('opensWith: a duplicated table belongs to the tour that opened with its first stop', () => {
  const { opensWith } = require('../../scripts/fetch-tour-schedules.js');
  const table = [{ city: 'Providence, RI', venue: 'PPAC', start: '2026-09-20', end: '2026-09-26' }];
  assert.equal(opensWith({ openingDate: '2026-09-20' }, table), true);
  assert.equal(opensWith({ openingDate: '2017-03-12' }, table), false, 'the Broadway-era date of a page carrying a copied table');
  assert.equal(opensWith(undefined, table), false);
});

test('tourStops keeps the current era only: after the launch, up to the closing', () => {
  const row = (city: string, venue: string, dates: string) => `<tr><td>${city}</td><td>${venue}</td><td>${dates}</td></tr>`;
  const html = `<table>${[
    row('Fayetteville, AR', 'Walton Arts Center', 'August 16-25, 2024'),
    row('Tulsa, OK', 'Tulsa PAC', 'August 27-September 8, 2024'),
    row('Kansas City, MO', 'Starlight', 'October 1-12, 2024'),
    row('Paducah, KY', 'Carson Center', 'October 30-November 1, 2024'),
  ].join('')}</table>`;
  const closed = tourStops({ id: 'x-tour-2024', openingDate: '2024-08-16', closingDate: '2024-10-12' }, html, new Date('2024-10-20T00:00:00Z'));
  assert.deepEqual(closed.map((s: TourStop) => s.city), ['Fayetteville, AR', 'Tulsa, OK', 'Kansas City, MO'], 'a second company after the closing is not this tour');
  // Launch before the page's first row: the running segment that began after it.
  const late = tourStops({ id: 'x-tour-2024', openingDate: '2024-06-01' }, html, new Date('2024-10-05T00:00:00Z'));
  assert.equal(late[0].city, 'Fayetteville, AR');
  assert.equal(tourStops({ id: 'x-tour-2019', openingDate: '2019-06-01' }, html, new Date('2024-10-05T00:00:00Z')), null, 'an old tour never takes a new company\'s schedule');
});
