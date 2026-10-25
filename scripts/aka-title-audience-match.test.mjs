import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { matchTheatrToShows } = require('./scrape-theatr-audience.js');
const { matchProductions } = require('./scrape-mezzanine-audience.js');
const { matchesAlias, venueAgrees } = require('./lib/aka-title-match.js');

// BRO-5943: Billy Crystal 860 is "860" on Theatr and Mezzanine.
const show = { id: 'billy-crystal-860-2026', title: 'Billy Crystal 860', akaTitles: ['860'], venue: 'Imperial Theatre', category: 'broadway', openingDate: '2026-10-21', previewsStartDate: '2026-10-01' };

test('alias needs the same house', () => {
  assert.ok(matchesAlias(show, '860', 'Imperial Theatre'));
  assert.ok(!matchesAlias(show, '860', 'Gershwin Theatre'));
  assert.ok(!matchesAlias(show, '861', 'Imperial Theatre'));
  assert.ok(venueAgrees('Imperial Theatre', 'Imperial'));
  assert.ok(!venueAgrees('New Amsterdam Theatre', 'New'), 'short bare prefix must not match');
  assert.ok(!venueAgrees('', 'Imperial Theatre'));
  assert.ok(venueAgrees('Théâtre Marigny', 'Theatre Marigny'), 'accented venue names fold before matching');
});

test('Theatr "860" at the Imperial attaches; same title elsewhere does not', () => {
  const ok = matchTheatrToShows([{ id: 1, name: '860', eventCategory: 'Broadway', venue: { name: 'Imperial Theatre' }, totalWatchedUsers: 3 }], [show]);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].show.id, show.id);
  assert.equal(ok[0].confidence, 'alias');
  const elsewhere = matchTheatrToShows([{ id: 2, name: '860', eventCategory: 'Off & Off-Off Broadway', venue: { name: 'Under St Marks' } }], [show]);
  assert.equal(elsewhere.length, 0);
});

test('a better-watched stray "Billy Crystal" row does not displace the real "860" row', () => {
  const rows = [
    { id: 3, name: 'Billy Crystal', eventCategory: 'Broadway', venue: { name: 'Imperial Theatre' }, totalWatchedUsers: 9 },
    { id: 4, name: '860', eventCategory: 'Broadway', venue: { name: 'Imperial Theatre' }, totalWatchedUsers: 3 },
  ];
  for (const order of [rows, [...rows].reverse()]) {
    const m = matchTheatrToShows(order, [show]);
    assert.equal(m.length, 1);
    assert.equal(m[0].theatr.id, 4);
    assert.equal(m[0].confidence, 'alias');
  }
});

test('Theatr venue given as a plain string still alias-matches', () => {
  const m = matchTheatrToShows([{ id: 5, name: '860', eventCategory: 'Broadway', venue: 'Imperial Theatre', totalWatchedUsers: 1 }], [show]);
  assert.equal(m.length, 1);
});

test('Mezzanine "860" at the Imperial attaches to Billy Crystal 860', () => {
  const prod = { objectId: 'p860', show: { name: '860' }, theater: { name: 'Imperial Theatre' }, opened: '2026-10-21', ratingsCount: 187, averageRating: 4.0 };
  const m = matchProductions([prod], [show]);
  assert.equal(m.length, 1);
  assert.equal(m[0].showId, show.id);
  assert.equal(m[0].ratingsCount, 187);
});

test('Mezzanine "860" at another theater does not attach', () => {
  const prod = { objectId: 'pX', show: { name: '860' }, theater: { name: 'Gershwin Theatre' }, opened: '2026-10-21', ratingsCount: 5, averageRating: 3.0 };
  assert.equal(matchProductions([prod], [show]).length, 0);
});

test('Mezzanine alias at the same house but a much older run does not attach', () => {
  const old = { objectId: 'pOld', show: { name: '860' }, theater: { name: 'Imperial Theatre' }, opened: '2019-03-01', ratingsCount: 40, averageRating: 4.0 };
  assert.equal(matchProductions([old], [show]).length, 0);
});

test('Theatr alias never attaches a West End show to a same-named NYC house', () => {
  const we = { id: 'x-west-end-2026', title: 'Press Title X', akaTitles: ['X'], venue: 'Lyceum Theatre', category: 'west-end', openingDate: '2026-09-01', previewsStartDate: '2026-08-15' };
  const m = matchTheatrToShows([{ id: 7, name: 'X', eventCategory: 'Broadway', venue: { name: 'Lyceum Theatre' }, totalWatchedUsers: 5 }], [we]);
  assert.equal(m.length, 0);
});

test('Theatr alias matches an accented venue spelling through the real matcher', () => {
  const fr = { ...show, id: 'y-2026', title: 'Press Title Y', akaTitles: ['Y'], venue: 'Theatre Marigny' };
  const m = matchTheatrToShows([{ id: 8, name: 'Y', eventCategory: 'Broadway', venue: { name: 'Théâtre Marigny' }, totalWatchedUsers: 2 }], [fr]);
  assert.equal(m.length, 1);
  assert.equal(m[0].confidence, 'alias');
});
