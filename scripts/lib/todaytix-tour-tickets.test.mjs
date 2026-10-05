import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normTitle, matchTourTickets, mergeTickets } = require('./todaytix-tour-tickets.js');

const listing = (o) => ({ id: 1, slug: 'x', displayName: 'Waitress', venue: 'Orpheum Theatre', startDate: '2026-11-13', endDate: '2026-11-15', areRegularTicketsAvailable: true, _locationId: 4, ...o });
const schedules = {
  'waitress-tour-2026': { stops: [
    { city: 'San Francisco, CA', venue: 'Orpheum Theatre', start: '2026-11-13', end: '2026-11-15' },
    { city: 'Costa Mesa, CA', venue: 'Segerstrom Center', start: '2027-04-27', end: '2027-05-02' },
  ] },
};
const tours = [{ id: 'waitress-tour-2026', title: 'Waitress' }];

test('normTitle drops Disney prefix, musical suffix and punctuation', () => {
  assert.equal(normTitle("Disney's Beauty and the Beast"), 'beauty and the beast');
  assert.equal(normTitle('BOOP! The Musical'), 'boop');
  assert.equal(normTitle('Oh, Mary!'), 'oh mary');
  assert.equal(normTitle('Buena Vista Social Club™'), 'buena vista social club');
  assert.equal(normTitle('Les Misérables'), 'les miserables');
  assert.equal(normTitle('Dead Girl’s Quinceañera'), normTitle("Dead Girl's Quinceañera"));
});

test('matches a listing to the stop it opens with, and builds the metro URL', () => {
  const out = matchTourTickets([listing({ id: 48183, slug: 'waitress' })], tours, schedules);
  assert.deepEqual(out['waitress-tour-2026'], [{
    city: 'San Francisco, CA', start: '2026-11-13', url: 'https://www.todaytix.com/sf-bay-area/shows/48183-waitress',
    onSale: true, todaytixId: 48183, locationId: 4,
  }]);
});

test('a same-title local production opening on another day does not match', () => {
  // Come From Away at the Marriott Theatre (Chicago) opened 2026-08-26, no tour stop then.
  assert.deepEqual(matchTourTickets([listing({ startDate: '2026-08-26' })], tours, schedules), {});
});

test('listings without a real start date, or outside the tour metros, never match', () => {
  assert.deepEqual(matchTourTickets([listing({ startDate: null })], tours, schedules), {});
  assert.deepEqual(matchTourTickets([listing({ startDate: 'null' })], tours, schedules), {});
  assert.deepEqual(matchTourTickets([listing({ _locationId: 1 })], tours, schedules), {});
});

test('two listings for one stop: the on-sale one wins', () => {
  const out = matchTourTickets([
    listing({ id: 1, areRegularTicketsAvailable: false }),
    listing({ id: 2, areRegularTicketsAvailable: true }),
  ], tours, schedules);
  assert.equal(out['waitress-tour-2026'][0].todaytixId, 2);
});

test('mergeTickets keeps a failed location\'s previous links and drops the rest', () => {
  const prev = { 'waitress-tour-2026': [
    { city: 'San Francisco, CA', start: '2026-11-13', url: 'a', onSale: true, locationId: 4 },
    { city: 'Costa Mesa, CA', start: '2027-04-27', url: 'b', onSale: true, locationId: 5 },
  ] };
  // Location 5 failed this run; location 4 answered with no listing for the tour.
  assert.deepEqual(mergeTickets(prev, {}, [5])['waitress-tour-2026'].map(l => l.url), ['b']);
  // Every location answered: stale links go.
  assert.deepEqual(mergeTickets(prev, {}, []), {});
});

test('a stop outside the listing\'s metro never takes its link (Milwaukee one-nighter before Chicago)', () => {
  const sched = { 't': { stops: [
    { city: 'Milwaukee, WI', venue: 'Marcus Center', start: '2026-10-11', end: '2026-10-11' },
    { city: 'Chicago, IL', venue: 'CIBC Theatre', start: '2026-10-13', end: '2026-10-25' },
  ] } };
  const out = matchTourTickets([listing({ id: 9, startDate: '2026-10-13', venue: 'CIBC Theatre', _locationId: 3 })], [{ id: 't', title: 'Waitress' }], sched);
  assert.deepEqual(out.t.map(l => l.city), ['Chicago, IL']);
});

test('same-state stops: the venue name decides (SF Orpheum vs San Jose)', () => {
  const sched = { 't': { stops: [
    { city: 'San Jose, CA', venue: 'Center for the Performing Arts', start: '2026-11-11', end: '2026-11-12' },
    { city: 'San Francisco, CA', venue: 'Orpheum Theatre', start: '2026-11-13', end: '2026-11-15' },
  ] } };
  const out = matchTourTickets([listing({ venue: 'Orpheum Theatre' })], [{ id: 't', title: 'Waitress' }], sched);
  assert.deepEqual(out.t.map(l => l.city), ['San Francisco, CA']);
  // A listing at a named venue the stop doesn't share is not this stop.
  assert.deepEqual(matchTourTickets([listing({ venue: 'Curran Theatre' })], [{ id: 't', title: 'Waitress' }], sched), {});
});

test('two companies of one title opening the same day: ambiguous, no link', () => {
  const stop = { city: 'San Francisco, CA', venue: 'Orpheum Theatre', start: '2026-11-13', end: '2026-11-15' };
  const sched = { a: { stops: [stop] }, b: { stops: [stop] } };
  assert.deepEqual(matchTourTickets([listing({})], [{ id: 'a', title: 'Waitress' }, { id: 'b', title: 'Waitress' }], sched), {});
});
