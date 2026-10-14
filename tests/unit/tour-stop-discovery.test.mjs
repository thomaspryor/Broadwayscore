/**
 * tour-stop-discovery (BRO-4656): which tour stops get a local-review search,
 * the query and window, and the publish-date check after ingest.
 *
 * Run: node --test tests/unit/tour-stop-discovery.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectDueStops, buildStopQuery, buildStopDateRange, stopDateWindowArg, looksLikeScreenVersion, unregisteredLooksLikeStopReview, stopKey } = require('../../scripts/lib/tour-stop-discovery.js');

const now = new Date('2026-10-05T12:00:00Z');
const show = { id: 'spamalot-tour-2025', title: 'Spamalot' };
const schedules = { 'spamalot-tour-2025': { stops: [
  { city: 'Worcester, MA', start: '2026-10-02', end: '2026-10-04' },
  { city: 'Spokane, WA', start: '2026-08-25', end: '2026-08-26' },
  { city: 'Denver, CO', start: '2026-01-06', end: '2026-01-18' },
  { city: 'Tampa, FL', start: '2026-11-03', end: '2026-11-08' },
] } };

test('recent stops are due weekly; older ones until done (max 3 attempts), newest first, up to the cap; future never', () => {
  const [worcester, spokane, denver] = schedules[show.id].stops;
  const due = selectDueStops([show], schedules, {}, { now, backfill: 1 });
  assert.deepEqual(due.map(d => `${d.why}:${d.stop.city}`), ['recent:Worcester, MA', 'backfill:Spokane, WA']);
  const state = {
    [stopKey(show.id, worcester)]: { at: '2026-10-03', done: true, attempts: 1 },
    [stopKey(show.id, spokane)]: { at: '2026-10-01', done: true, attempts: 1 },
  };
  assert.deepEqual(selectDueStops([show], schedules, state, { now, backfill: 5 }).map(d => d.stop.city), ['Denver, CO']);
  // Searched a week ago: due again while the stop is recent.
  state[stopKey(show.id, worcester)].at = '2026-09-28';
  assert.deepEqual(selectDueStops([show], schedules, state, { now, backfill: 0 }).map(d => d.stop.city), ['Worcester, MA']);
  // Cut short twice: retried; a third failed attempt retires it.
  state[stopKey(show.id, denver)] = { at: '2026-10-04', done: false, attempts: 2 };
  assert.deepEqual(selectDueStops([show], schedules, state, { now, backfill: 5 }).map(d => d.stop.city), ['Worcester, MA', 'Denver, CO']);
  state[stopKey(show.id, denver)].attempts = 3;
  assert.deepEqual(selectDueStops([show], schedules, state, { now, backfill: 5 }).map(d => d.stop.city), ['Worcester, MA']);
  assert.deepEqual(selectDueStops([{ id: 'none', title: 'X' }], schedules, {}, { now, backfill: 5 }), []);
  // A long engagement stays recent while it plays, past the 4-week mark.
  const long = { boston: { stops: [{ city: 'Boston, MA', start: '2026-08-23', end: '2026-11-15' }] } };
  assert.equal(selectDueStops([{ id: 'boston', title: 'Wicked' }], long, {}, { now })[0].why, 'recent');
});

test('query names the city; window runs a week before opening to a month after closing, never past tomorrow', () => {
  const denver = schedules[show.id].stops[2];
  assert.equal(buildStopQuery(show, denver), '"Spamalot" review Denver');
  const r = buildStopDateRange(denver, now);
  assert.equal(r.dateMin.toISOString().slice(0, 10), '2025-12-30');
  assert.equal(r.dateMax.toISOString().slice(0, 10), '2026-02-17');
  assert.equal(buildStopDateRange(schedules[show.id].stops[0], now).dateMax.toISOString().slice(0, 10), '2026-10-06');
});

test('ingest gets the full stop window, never clipped to today', () => {
  assert.equal(stopDateWindowArg(schedules[show.id].stops[2]), '2025-12-30,2026-02-17');
});

test('screen versions are rejected by title, URL section or release wording; stage reviews mentioning the movie pass', () => {
  assert.equal(looksLikeScreenVersion({ url: 'https://buffalonews.com/entertainment/movies/wicked-for-good/', title: "'Wicked: For Good' review" }), true);
  assert.equal(looksLikeScreenVersion({ url: 'https://x.com/a', title: 'Wicked movie review: Ariana shines' }), true);
  assert.equal(looksLikeScreenVersion({ url: 'https://x.com/a', title: 'Review: Wicked', description: 'now in theaters nationwide' }), true);
  assert.equal(looksLikeScreenVersion({ url: 'https://x.com/a', title: 'Beetlejuice tour review: the movie, live on stage', description: 'fans of the movie will love it' }), false);
  assert.equal(looksLikeScreenVersion({ url: 'https://x.com/theater/a', title: 'Review: Spamalot at the Buell' }), false);
  // A bare "box office" or "opening weekend" is the theatre's (BRO-4656 QA: Buffalo Rising's Suffs review).
  assert.equal(looksLikeScreenVersion({ url: 'https://x.com/a', title: 'Review: Suffs', description: 'The box office is at 650 Main St. Tickets remain for opening weekend.' }), false);
  assert.equal(looksLikeScreenVersion({ url: 'https://x.com/a', title: 'Wicked: For Good', description: 'a record opening weekend box office' }), true);
  // A news video clip found for the Des Moines stop (BRO-4656 first dry run).
  assert.equal(looksLikeScreenVersion({ url: 'https://www.yahoo.com/news/videos/wicked-musical-brings-oz-magic-214317790.html', title: 'Wicked musical brings Oz magic' }), true);
});

test('an unregistered domain is ingested only when its title names the show and says review', () => {
  assert.equal(unregisteredLooksLikeStopReview(show, { title: 'Spamalot review: knights who say ni' }), true);
  assert.equal(unregisteredLooksLikeStopReview(show, { title: 'Things to do in Denver this weekend' }), false);
  assert.equal(unregisteredLooksLikeStopReview(show, { title: 'Review: Wicked at the Buell' }), false);
  // Whole words only: SIX is not "Six Flags", Spamalot is not "Spamalotish".
  assert.equal(unregisteredLooksLikeStopReview({ title: 'SIX' }, { title: 'Six Flags Fright Fest review' }), false);
  assert.equal(unregisteredLooksLikeStopReview({ title: 'SIX' }, { title: 'Review: SIX at the Fox' }), true);
  assert.equal(unregisteredLooksLikeStopReview({ title: 'SIX' }, { title: 'Six the musical review: queens rule' }), true);
  assert.equal(unregisteredLooksLikeStopReview(show, { title: 'Spamalotish review' }), false);
  assert.equal(unregisteredLooksLikeStopReview({ title: 'Oh, Mary!' }, { title: 'Review: Oh, Mary! at the Bushnell' }), true);
});

test('a schedule row ending before it starts is never searched', () => {
  const tours = [{ id: 't' }];
  const schedules = { t: { stops: [{ city: 'Chicago, IL', start: '2022-11-17', end: '2022-01-14' }] } };
  assert.deepEqual(selectDueStops(tours, schedules, {}, { now: new Date('2026-10-05'), backfill: 5 }), []);
});

test('parseDateRange: a cross-New-Year run whose source repeats the start year ends the next year', () => {
  const { parseDateRange } = require('../../scripts/lib/tour-schedule.js');
  const r = parseDateRange('November 17, 2022–January 14, 2022');
  assert.equal(r.end.toISOString().slice(0, 10), '2023-01-14');
  assert.equal(parseDateRange('March 5, 2022–January 14, 2021'), null);
  assert.equal(parseDateRange('June 1, 2022–June 5, 2022').end.toISOString().slice(0, 10), '2022-06-05');
});

test('an overseas production on a country domain is never a tour stop review (BRO-4656)', () => {
  const { isOverseasHost } = require('../../scripts/lib/tour-stop-discovery.js');
  const { tourCandidateIsTour } = require('../../scripts/lib/regional-serp-discovery.js');
  const tour = { id: 'spamalot-tour-2025', title: 'Spamalot', market: 'tour' };
  // The Melbourne season review the first scheduled run ingested.
  const melbourne = { url: 'https://australianpridenetwork.com.au/monty-pythons-spamalot-review/', title: "Monty Python's SPAMALOT (review)" };
  assert.equal(isOverseasHost(melbourne.url), true);
  assert.equal(tourCandidateIsTour(tour, melbourne), false);
  for (const url of ['https://www.whatsonstage.com/x', 'https://www.thestage.co.uk/reviews/x', 'https://kurier.at/kultur/x']) {
    assert.equal(isOverseasHost(url), url.includes('.co.uk') || url.includes('.at/'), url);
  }
  // US, Canadian and Mexican sites, and generic ccTLDs used by US outlets.
  for (const url of ['https://www.theglobeandmail.com/x', 'https://nowtoronto.ca/x', 'https://www.milenio.mx/x', 'https://broadwayradio.fm/x', 'https://thetheatre.co/x', 'https://ladyadventure.tv/x']) {
    assert.equal(isOverseasHost(url), false, url);
  }
  assert.equal(tourCandidateIsTour(tour, { url: 'https://roughdraftatlanta.com/2026/07/23/spamalot-atlanta-review/', title: 'Spamalot review' }), true);
  // Non-tour shows are untouched (a West End review on a .co.uk site).
  assert.equal(tourCandidateIsTour({ id: 'x', market: 'west-end' }, { url: 'https://www.thestage.co.uk/reviews/x' }), true);
});
