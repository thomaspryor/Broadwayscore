import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveMetro, resolveMetroInfo, hubMetros, citySlug, TABLE } = require('./venue-metro.js');
const { REGIONAL_FEEDER_VENUES, feederVenueCity } = require('./aggregator-candidate-extract.js');

test('table covers the six UK hubs plus Chicago, DC and LA with >=40 venues', () => {
  assert.ok(TABLE.venues.length >= 40, `only ${TABLE.venues.length} venues`);
  for (const hub of ['manchester', 'yorkshire', 'bristol-bath', 'stratford', 'chichester', 'scotland', 'chicago', 'washington-dc', 'los-angeles']) {
    const metros = hubMetros(hub);
    assert.ok(metros.length > 0, `hub ${hub} has no metros`);
    assert.ok(TABLE.venues.some((v) => metros.includes(v.metro)), `hub ${hub} has no venues`);
  }
});

test('every venue and place points at a declared metro', () => {
  for (const v of TABLE.venues) assert.ok(TABLE.metros[v.metro], `${v.venue} -> unknown metro ${v.metro}`);
  for (const [p, m] of Object.entries(TABLE.places)) assert.ok(TABLE.metros[m], `${p} -> unknown metro ${m}`);
  for (const [slug, m] of Object.entries(TABLE.metros)) {
    if (m.hub) assert.ok(TABLE.hubs[m.hub], `${slug} -> unknown hub ${m.hub}`);
  }
});

test('resolves real shows.json venue spellings', () => {
  const cases = [
    ['Royal Exchange Theatre, Manchester', 'manchester-uk'],
    ['Royal Shakespeare Theatre, Stratford-upon-Avon', 'stratford-upon-avon-uk'],
    ['Minerva Theatre, Chichester', 'chichester-uk'],
    ['Crucible Theatre, Sheffield', 'sheffield-uk'],
    ['Theatre Royal, Bath', 'bath-uk'],
    ['Citizens Theatre, Glasgow', 'glasgow-uk'],
    ["A.R.T.'s Loeb Drama Center, Cambridge, MA", 'boston-ma'],
    ['Signature Theatre (The MAX), Arlington, VA', 'washington-dc'],
    ['Northlight Theatre, Evanston, IL', 'chicago-il'],
    ['Ahmanson Theatre, Los Angeles, CA', 'los-angeles-ca'],
    ['Goodman Theatre, Chicago, IL', 'chicago-il'],
    ['Emerson Colonial Theatre, Boston, MA', 'boston-ma'],
  ];
  for (const [venue, want] of cases) assert.equal(resolveMetro(venue), want, venue);
});

test('generic US suffix uses the /tours/[city] slug rule', () => {
  assert.equal(resolveMetro('Some New House, Nashville, TN'), citySlug('Nashville, TN'));
  assert.equal(resolveMetroInfo('Some New House, Nashville, TN').country, 'US');
  assert.equal(resolveMetroInfo('Stratford Festival Theatre, Stratford, ON').country, 'CA');
});

test('London, NYC, multi-city and generic names do not resolve', () => {
  for (const venue of [
    'Lyceum Theatre', 'Lyric Theatre', 'Old Vic', 'The Old Vic, London', 'Theatre Royal Drury Lane',
    'Theatre Royal Haymarket', 'Signature Theatre', 'Home', 'Lyric Hammersmith', 'Everyman Theatre, Cheltenham',
    'U.S. National Tour (Chicago, Los Angeles, Washington D.C., San Francisco, Boston)',
    'Regional Tryouts (Arlington, VA 2020; Millburn, NJ 2024)', '', null,
    // display names never match bare (second-opinion review, BRO-6515)
    'Royal Court Theatre', 'Court Theatre', 'Old Globe Theatre, London', 'The Wallis Theatre, London',
    'Park Avenue Armory, New York, NY', 'Steppenwolf, London, UK', 'The Wallis, London, England',
  ]) assert.equal(resolveMetro(venue), null, String(venue));
});

test('no drift: every REGIONAL_FEEDER_VENUES city resolves to a metro', () => {
  const cities = [...new Set(REGIONAL_FEEDER_VENUES.map((v) => v.city))];
  for (const city of cities) {
    const venue = `Test House, ${city}`;
    assert.ok(resolveMetro(venue), `feeder city ${city} unmapped`);
  }
  assert.equal(feederVenueCity('Royal Exchange Theatre'), 'Manchester');
});

test('regional add path stamps city from the same table', () => {
  const { buildRegionalShowEntry } = require('../promote-ob-venue-candidates.js');
  const uk = buildRegionalShowEntry({ title: 'Hamlet', venue: 'Royal Exchange Theatre', articlePublishedAt: '2025-03-01T10:00:00Z', source: 'guardian-review' });
  assert.equal(uk.city, 'manchester-uk');
  const us = buildRegionalShowEntry({ title: 'Ragtime', venue: 'Goodman Theatre', articlePublishedAt: '2025-03-01T10:00:00Z', source: 'bww' });
  assert.equal(us.city, 'chicago-il');
});

test('an explicit trailing place beats an alias that points elsewhere', () => {
  assert.equal(resolveMetro('Northern Stage, White River Junction, VT'), 'white-river-junction-vt');
  assert.equal(resolveMetro('Northern Stage, Newcastle'), 'newcastle-uk');
  assert.equal(resolveMetro('Crucible, Sheffield'), 'sheffield-uk');
});
