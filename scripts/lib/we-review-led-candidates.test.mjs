// BRO-5031: review-led WE historical candidates. Fixtures are real rows:
// unlistedReviews from data/audit/we-historical-candidates-*.json and TR
// production links saved in review-texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  selectLookups, trIssueMonth, trVenueName, pickTrForReview, findContinuingRun, cleanReviewTitle,
} = require('./we-review-led-candidates.js');
const { isLondonVenue } = require('./tr-london-venue.js');
const { searchTitles, pdfHeaderFor } = require('../resolve-we-unlisted-tr.js');

// we-historical-candidates-2018-2019.json unlistedReviews (verbatim)
const COMPANY = { title: 'Company', venue: 'Gielgud Theatre', date: '2018-10-17', url: 'https://www.whatsonstage.com/news/review-company-gielgud-theatre_47830/', rating: 5, market: [83, 98] };
const RED_DUST_ROAD = { title: 'Red Dust Road', venue: 'Lyceum Theatre', date: '2019-08-15', url: 'https://www.whatsonstage.com/news/review-red-dust-road-lyceum-theatre_49687/', rating: 3, market: [] };
const ILLUSIONISTS = { title: 'The Illusionists', venue: 'Shaftesbury Theatre', date: '2019-07-11', url: 'https://www.whatsonstage.com/news/review-the-illusionists-shaftesbury-theatre_49440/', rating: 3, market: [83, 85] };
const ANTONY = { title: 'Antony and Cleopatra', venue: 'National Theatre', date: '2018-09-27', url: 'https://www.whatsonstage.com/news/review-antony-and-cleopatra-national-theatre_47683/', rating: 5, market: [83] };
// we-historical-candidates-2020-2021.json
const PHANTOM_2021 = { title: 'The Phantom of the Opera', venue: "Her Majesty's Theatre", date: '2021-08-11', url: 'https://www.whatsonstage.com/news/the-phantom-of-the-opera-at-her-majestys-theatre-review_54675/', rating: 4, market: [83] };

test('selectLookups keeps London theatre reviews, drops Edinburgh Lyceum and magic shows', () => {
  const { lookups, dropped } = selectLookups([COMPANY, RED_DUST_ROAD, ILLUSIONISTS, ANTONY, { ...COMPANY }], '2018-2019');
  assert.deepEqual(lookups.map(l => l.title), ['Company', 'Antony and Cleopatra']);
  assert.deepEqual(dropped.map(d => [d.title, d.reason]), [
    ['Red Dust Road', 'WOS review not tagged London'],
    ['The Illusionists', 'concert/screening/magic title'],
    ['Company', 'duplicate review'],
  ]);
});

test('selectLookups drops a review dated outside the season', () => {
  const { lookups, dropped } = selectLookups([COMPANY], '2019-2020');
  assert.equal(lookups.length, 0);
  assert.equal(dropped[0].reason, 'review outside season');
});

test('cleanReviewTitle strips the curly quotes WOS uses on 2022-23 titles', () => {
  assert.equal(cleanReviewTitle('”The Unfriend”'), 'The Unfriend');
  assert.equal(cleanReviewTitle('”Gabriel Byrne: Walking with Ghosts”'), 'Gabriel Byrne: Walking with Ghosts');
  assert.equal(cleanReviewTitle("Everybody's Talking About Jamie"), "Everybody's Talking About Jamie");
});

test('trIssueMonth reads HTML-era months and PDF-era volume/issue', () => {
  const m = (y, mo) => y * 12 + (mo - 1);
  assert.equal(trIssueMonth('https://www.theatrerecord.com/archive/2025/2/17206-oedipus'), m(2025, 2));
  // Dear Evan Hansen, Noël Coward, opened 2019-11-19
  assert.equal(trIssueMonth('https://www.theatrerecord.com/archive/volume/39/dest/22_dear_evan_hansen'), m(2019, 10));
  // Groan Ups, Vaudeville, opened 2019-09-25
  assert.equal(trIssueMonth('https://www.theatrerecord.com/archive/volume/39/dest/19_groan_ups'), m(2019, 9));
  assert.equal(trIssueMonth('https://www.theatrerecord.com/search?query=x'), null);
});

test('trVenueName strips the city but keeps National Theatre stage names whole', () => {
  assert.equal(trVenueName('Gielgud Theatre, London W1'), 'Gielgud Theatre');
  assert.equal(trVenueName('Olivier, National Theatre, London'), 'Olivier, National Theatre');
});

test('isLondonVenue rejects same-named houses in other cities', () => {
  assert.equal(isLondonVenue('Royal Lyceum Theatre, Edinburgh'), false);
  assert.equal(isLondonVenue('Lyceum Theatre, London'), true);
});

test('pickTrForReview takes the London production near the review, not a tour or old revival', () => {
  const results = [
    { title: 'Company', venue: 'Gielgud Theatre, London', link: 'https://www.theatrerecord.com/archive/volume/38/dest/21_company' },
    { title: 'Company', venue: 'Donmar Warehouse, London', link: 'https://www.theatrerecord.com/archive/volume/16/dest/1_company' },
    { title: 'Company', venue: 'Theatre Royal, Bath', link: 'https://www.theatrerecord.com/archive/2023/4/15000-company' },
  ];
  const pick = pickTrForReview(results, COMPANY, { isLondonVenue });
  assert.equal(pick.link, results[0].link);
  // Same venue, review a year later: no TR issue in the window
  assert.equal(pickTrForReview(results, { ...COMPANY, date: '2019-10-17' }, { isLondonVenue }), null);
});

test('findContinuingRun matches a reopening of an open long-runner (Phantom 2021)', () => {
  const shows = [{ id: 'the-phantom-of-the-opera-west-end-1986', title: 'The Phantom of the Opera', venue: "His Majesty's Theatre", market: 'west-end', previewsStartDate: '1986-09-27', openingDate: '1986-10-09', status: 'open' }];
  assert.equal(findContinuingRun(shows, PHANTOM_2021.title, '2021-07-27')?.id, 'the-phantom-of-the-opera-west-end-1986');
  assert.equal(findContinuingRun(shows, 'Company', '2018-09-26'), null);
});

test('searchTitles also searches each part of a double bill or season title', () => {
  assert.deepEqual(searchTitles('Pinter Seven A Slight Ache / The Dumb Waiter'), ['Pinter Seven A Slight Ache / The Dumb Waiter', 'Pinter Seven A Slight Ache', 'The Dumb Waiter']);
  assert.deepEqual(searchTitles('Into the Woods'), ['Into the Woods']);
});

test('pdfHeaderFor keeps only the production block above the first review date', () => {
  const text = 'previous production\n  COMPANY            THE STAGE\nby Stephen Sondheim\nGielgud Theatre\n17 October 2018\nreview body here';
  const h = pdfHeaderFor(text, 'Company');
  assert.match(h, /^COMPANY/);
  assert.match(h, /Gielgud Theatre/);
  assert.doesNotMatch(h, /review body/);
  assert.equal(pdfHeaderFor(text, 'Follies'), null);
});
