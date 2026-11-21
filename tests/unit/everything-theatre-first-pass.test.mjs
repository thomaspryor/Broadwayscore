// BRO-7401: the first pass kept missing Everything Theatre's Off-West End reviews (Ceilidh The Musical,
// The Moth, Speculations, Dogstar); the aggregator-gap sweep found each one later. Three causes, one
// test each, all on the real code:
//   1. the outlet was census-only, so the 3-hourly opening-window run never read it;
//   2. the window closed 3 days after opening, Dogstar's review went up on day 5;
//   3. the page check voided Speculations' review because two finished runs at Marylebone Theatre
//      were still "open", although the page names neither.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ow = require('../../scripts/lib/outlet-opening-window.js');
const poller = require('../../scripts/outlet-listing-poller.js');
const { pageConfirmsShow } = require('../../scripts/lib/outlet-listing-helpers.js');

const NOW = Date.parse('2026-11-14T13:00:00Z'); // Dogstar's review went up 2026-11-14 11:58 UTC
const day = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

test('Everything Theatre is a feed the opening-window run reads (wp-api, page-confirmed)', () => {
  const cfg = poller.WP_API_CONFIG['everything-theatre'];
  assert.ok(cfg, 'everything-theatre must have a WP_API_CONFIG feed entry');
  assert.equal(cfg.pageConfirmAll, true, 'headline matches need the page check (Mean Girls Sheffield is not Girls)');
  assert.ok(cfg.urlFilter.test('https://everything-theatre.co.uk/2026/11/review-dogstar-hampstead-theatre/'));
  assert.equal(ow.windowStrategyFor('everything-theatre', poller.OUTLET_STRATEGY_CONFIG, poller.WP_API_CONFIG), 'wp-api');

  const dogstar = { id: 'dogstar-off-west-end-2026', category: 'off-west-end', openingDate: '2026-11-09', status: 'open' };
  const past = [1, 2].map((i) => ({ id: `owe-${i}`, category: 'off-west-end', openingDate: day(20 * i), status: 'open' }));
  const reviews = past.map((s) => ({ outletId: 'everything-theatre', showId: s.id }));
  const sel = ow.selectWindowOutlets({
    windowShows: [dogstar], allShows: [dogstar, ...past], allReviews: reviews,
    outletStrategyConfig: poller.OUTLET_STRATEGY_CONFIG, wpApiConfig: poller.WP_API_CONFIG, skipOutlets: poller.SKIP_OUTLETS, now: NOW,
  });
  assert.ok(sel.outlets.includes('everything-theatre'), `window outlets: ${sel.outlets.join(',')}`);
});

test('Off-West End shows stay in the opening window for 7 days (Dogstar, day 5); others keep 3', () => {
  const shows = [
    { id: 'dogstar-off-west-end-2026', category: 'off-west-end', openingDate: '2026-11-09', status: 'open' },
    { id: 'owe-day8', category: 'off-west-end', openingDate: day(8), status: 'open' },
    { id: 'ob-day4', category: 'off-broadway', openingDate: day(4), status: 'open' },
    { id: 'we-day3', category: 'west-end', openingDate: day(3), status: 'open' },
  ];
  assert.deepEqual(ow.selectWindowShows(shows, NOW).map((s) => s.id), ['dogstar-off-west-end-2026', 'we-day3']);
  assert.equal(ow.windowDaysFor('off-west-end'), 7);
  assert.equal(ow.windowDaysFor('broadway'), 3);
  // an explicit maxDaysPast still wins for every market
  assert.deepEqual(ow.selectWindowShows(shows, NOW, { maxDaysPast: 3 }).map((s) => s.id), ['we-day3']);
});

const page = (body) => ` Review: Speculations, Marylebone Theatre ${body} `;
const speculations = { id: 'speculations-off-west-end-2026', title: 'Speculations', venue: 'Marylebone Theatre', openingDate: '2026-11-05', status: 'open' };
const smile = { id: 'the-smile-of-her-off-west-end-2026', title: 'The Smile Of Her', venue: 'Marylebone Theatre', openingDate: '2026-07-16', status: 'open' };
const tartuffe = { id: 'tartuffe-remixed-off-west-end-2026', title: 'Tartuffe Remixed', venue: 'Marylebone Theatre', openingDate: '2026-09-11', status: 'open' };

test('a same-house rival the page never names does not void the venue (Speculations)', () => {
  const text = page('Speculations is a bracing new play at the Marylebone Theatre about money and memory.');
  assert.equal(pageConfirmsShow(text, speculations, { otherShows: [speculations, smile, tartuffe] }), true);
});

test('a same-house rival the page names still voids the venue', () => {
  const text = page('Speculations follows Tartuffe Remixed into the Marylebone Theatre this autumn.');
  assert.equal(pageConfirmsShow(text, speculations, { otherShows: [speculations, tartuffe] }), false);
});

test('a venue form that is part of a different house name stays ambiguous (Old Vic vs Bristol Old Vic)', () => {
  const carol = { id: 'a-christmas-carol-west-end-2026', title: 'A Christmas Carol', venue: 'The Old Vic', openingDate: '2026-11-24', status: 'previews' };
  const lanny = { id: 'lanny-bristol-old-vic-regional-2026', title: 'Lanny', venue: 'Bristol Old Vic', openingDate: '2026-10-01', status: 'open' };
  // a film review of "Ebenezer: A Christmas Carol" that mentions an actor's Old Vic past
  const text = ' Ebenezer: A Christmas Carol is a horror-tinged film. Its star once played Scrooge at the Old Vic. ';
  assert.equal(pageConfirmsShow(text, carol, { otherShows: [carol, lanny] }), false);
});

test('the daily run keeps reading the census for Everything Theatre (closed runs, feed failure)', () => {
  const census = require('../../scripts/lib/outlet-listing-census.js');
  assert.equal(poller.WP_API_CONFIG['everything-theatre'].keepCensus, true);
  // what the poller passes for a keepCensus feed: hasFeed false, so the census is read every daily run
  assert.equal(census.shouldUseCensus({ outletId: 'everything-theatre', hasFeed: false, lookbackDays: 7, env: {} }).use, true);
});

test('a same-house rival with a compound venue ("/Main Stage") does not void an unnamed venue', () => {
  const r = { ...tartuffe, venue: 'Marylebone Theatre/Main Stage' };
  assert.equal(pageConfirmsShow(page('Speculations, a new play at the Marylebone Theatre.'), speculations, { otherShows: [speculations, r] }), true);
});
