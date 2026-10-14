// Tests for the WhatsOnStage REST adapter (BRO-4851). Fixtures are real API
// rows captured 2026-10-07, trimmed to the fields the adapter reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  decodeEntities, canonicalWosVenue, wosDate, parseWosShow, parseWosReviewTitle, cleanReviewedTitle,
} = require('./wos-rest-listings.js');

const KYOTO_RAW = {
  id: 1636496,
  link: 'https://www.whatsonstage.com/shows/london-theatre/west-end-theatre/kyoto_1708316438/',
  title: { rendered: 'Kyoto' },
  genre: [58],
  acf: { the_venue: [1003807], preview_date: '20250109', opening_date: null, closing_date: '20250503' },
};

test('wosDate converts ACF YYYYMMDD and rejects junk', () => {
  assert.equal(wosDate('20250109'), '2025-01-09');
  assert.equal(wosDate(null), null);
  assert.equal(wosDate(''), null);
  assert.equal(wosDate('2025-01-09'), null);
  assert.equal(wosDate('2025019'), null);
});

test('parseWosShow normalizes a real listing row', () => {
  const row = parseWosShow(KYOTO_RAW, new Map([[1003807, '@sohoplace']]), new Map([[58, 'play']]));
  assert.deepEqual(row, {
    wosId: 1636496,
    title: 'Kyoto',
    venue: '@sohoplace',
    venueId: 1003807,
    previewsStartDate: '2025-01-09',
    openingDate: null,
    closingDate: '2025-05-03',
    genres: ['play'],
    url: KYOTO_RAW.link,
  });
});

test('parseWosShow tolerates a missing venue id and plain-object maps', () => {
  const row = parseWosShow({ ...KYOTO_RAW, acf: { ...KYOTO_RAW.acf, the_venue: null } }, {}, { 58: 'play' });
  assert.equal(row.venue, null);
  assert.deepEqual(row.genres, ['play']);
});

test('canonicalWosVenue maps WOS National Theatre / Royal Court naming to shows.json names', () => {
  assert.equal(canonicalWosVenue('Olivier (National Theatre)'), 'Olivier Theatre');
  assert.equal(canonicalWosVenue('Lyttelton (National Theatre)'), 'Lyttelton Theatre');
  assert.equal(canonicalWosVenue('Dorfman Theatre (National Theatre)'), 'Dorfman Theatre');
  assert.equal(canonicalWosVenue('Royal Court &#8211; Jerwood Theatre Downstairs'), 'Royal Court Theatre');
  assert.equal(canonicalWosVenue('Wyndham&#8217;s Theatre'), "Wyndham's Theatre");
  assert.equal(canonicalWosVenue('Gielgud Theatre'), 'Gielgud Theatre');
});

test('decodeEntities handles WordPress rendered-title entities and tags', () => {
  assert.equal(decodeEntities('The New Real at the RSC&#8217;s The Other Place – review'), 'The New Real at the RSC’s The Other Place – review');
  assert.equal(decodeEntities('<p class="p1">Lindsey Ferrentino&#039;s play</p>'), "Lindsey Ferrentino's play");
});

test('parseWosReviewTitle: "X at the Venue – review" form (real titles)', () => {
  assert.deepEqual(parseWosReviewTitle('Brace Brace at the Royal Court – review', ''), { title: 'Brace Brace', venue: 'Royal Court' });
  assert.deepEqual(
    parseWosReviewTitle('Here We Are at the National Theatre review – Sondheim&#8217;s final musical is mystifying and magical', ''),
    { title: 'Here We Are', venue: 'National Theatre' });
});

test('parseWosReviewTitle: "X review – subhead" form takes the venue from the teaser', () => {
  const r = parseWosReviewTitle(
    'The Fear of 13 review – Adrien Brody is sensational in new era for the Donmar Warehouse',
    '<p>Running at the Donmar Warehouse until 30 November</p>');
  assert.equal(r.title, 'The Fear of 13');
  assert.equal(r.venue, 'Donmar Warehouse');
});

test('parseWosReviewTitle: the venue follows the LAST " at " (titles containing "at")', () => {
  assert.deepEqual(
    parseWosReviewTitle("Breakfast at Tiffany's at the Theatre Royal Haymarket – review", ''),
    { title: "Breakfast at Tiffany's", venue: 'Theatre Royal Haymarket' });
});

test('parseWosReviewTitle: pre-2020 "Review: <em>X</em> (Venue)" form (real 2018 titles)', () => {
  assert.deepEqual(parseWosReviewTitle('Review: <em>Wise Children</em> (The Old Vic)', ''), { title: 'Wise Children', venue: 'Old Vic' });
  assert.deepEqual(parseWosReviewTitle('Review: <em>The Inheritance</em> (Noël Coward Theatre)', ''), { title: 'The Inheritance', venue: 'Noël Coward Theatre' });
  assert.equal(parseWosReviewTitle('Did <em>Company</em> drive critics crazy?', ''), null);
});

test('parseWosReviewTitle returns null for non-review posts', () => {
  assert.equal(parseWosReviewTitle('Casting announced for Kyoto transfer', ''), null);
});

test('cleanReviewedTitle strips WOS decorations but keeps real "with" titles', () => {
  assert.equal(cleanReviewedTitle('Unicorn West End'), 'Unicorn');
  assert.equal(cleanReviewedTitle('Retrograde in the West End –'), 'Retrograde');
  assert.equal(cleanReviewedTitle('Evita with Rachel Zegler'), 'Evita');
  assert.equal(cleanReviewedTitle('The Fifth Step with Martin Freeman and Jack Lowden in the West End –'), 'The Fifth Step');
  assert.equal(cleanReviewedTitle('Coriolanus starring David Oyelowo'), 'Coriolanus');
  assert.equal(cleanReviewedTitle('The Devil Wears Prada musical'), 'The Devil Wears Prada');
  assert.equal(cleanReviewedTitle('Robin Hood pantomime'), 'Robin Hood');
  assert.equal(cleanReviewedTitle('A Room with a View'), 'A Room with a View');
  assert.equal(cleanReviewedTitle('An Evening with Gary Lineker'), 'An Evening with Gary Lineker');
  assert.equal(cleanReviewedTitle('Burlesque the Musical'), 'Burlesque the Musical');
});
