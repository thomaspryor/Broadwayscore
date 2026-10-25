// BRO-5031: review-led WE historical candidates. Fixtures are real rows:
// unlistedReviews from data/audit/we-historical-candidates-*.json and TR
// production links saved in review-texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  selectLookups, trIssueMonth, trIssueMonthRange, isIssuePeriod, trVenueName, pickTrForReview, findContinuingRun, cleanReviewTitle,
} = require('./we-review-led-candidates.js');
const { isLondonVenue } = require('./tr-london-venue.js');
const { searchTitles, pdfHeaderFor, htmlHeaderFor, pairLabelLines } = require('../resolve-we-unlisted-tr.js');

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

test('pickTrForReview dates 2018 page-numbered TR links by volume year (BRO-5031)', () => {
  // we-historical-review-led-2018-2019.json trResults (verbatim): the 2018
  // volume links by page, not issue, so these went unmatched before.
  const m = (y, mo) => y * 12 + (mo - 1);
  assert.deepEqual(trIssueMonthRange('https://www.theatrerecord.com/archive/volume/38/page/943'), { lo: m(2018, 1), hi: m(2018, 12) });
  assert.equal(trIssueMonth('https://www.theatrerecord.com/archive/volume/38/page/943'), null);
  const company = [{ title: 'Company', venue: 'Gielgud (Globe)', link: 'https://www.theatrerecord.com/archive/volume/38/page/943' }];
  assert.equal(pickTrForReview(company, COMPANY, { isLondonVenue }).link, company[0].link);
  const storm = [{ title: 'Height of the Storm (The)', venue: "Wyndham's", link: 'https://www.theatrerecord.com/archive/volume/38/page/924' }];
  const STORM = { title: 'The Height of the Storm', venue: "Wyndham's Theatre", date: '2018-10-10' };
  assert.equal(pickTrForReview(storm, STORM, { isLondonVenue }).link, storm[0].link);
  // A 2018 page link never matches a review two years on
  assert.equal(pickTrForReview(storm, { ...STORM, date: '2020-10-10' }, { isLondonVenue }), null);
  // An issue-dated link in the review month beats a whole-year page link
  const both = [storm[0], { ...storm[0], link: 'https://www.theatrerecord.com/archive/volume/38/dest/21_height' }];
  assert.equal(pickTrForReview(both, STORM, { isLondonVenue }).link, both[1].link);
});

test('a whole-month range with no press night is a TR issue period, not a run (BRO-5031)', () => {
  // we-historical-review-led-2018-2019.json headers (verbatim)
  assert.equal(isIssuePeriod(parseTrHeaderDates('ANTONY AND CLEOPATRA\n1-30 September 2018')), true);
  assert.equal(isIssuePeriod(parseTrHeaderDates('SNOW WHITE\n01 – 31 December 2018')), true);
  // Real runs stay runs
  assert.equal(isIssuePeriod(parseTrHeaderDates('X\n1 – 22 December 2018')), false);
  assert.equal(isIssuePeriod(parseTrHeaderDates('ROSMERSHOLM\nPreviews 24 Apr 2019\nPress Night 02 May 2019\nCloses 20 Jul 2019')), false);
  // The 2018 PDF running head is skipped, so no header comes from it
  const pdf = ['ANTONY AND CLEOPATRA', 'by William Shakespeare', 'Issue 17-18 Openings 1-30 September 2018', 'Reviews'].join('\n');
  assert.equal(pdfHeaderFor(pdf, 'Antony and Cleopatra'), null);
  // -layout can print the banner beside a real label: keep the label's date
  const side = ['ANTONY AND CLEOPATRA', 'Press Night 27 Sep 2018      Issue 17-18 Openings 1-30 September 2018', 'Reviews'].join('\n');
  assert.equal(parseTrHeaderDates(pdfHeaderFor(side, 'Antony and Cleopatra')).openingDate, '2018-09-27');
  // ...or after it: the label to the right survives too
  const right = ['ANTONY AND CLEOPATRA', 'Issue 17-18 Openings 1-30 September 2018      Closes 19 Jan 2019', 'Reviews'].join('\n');
  assert.equal(parseTrHeaderDates(pdfHeaderFor(right, 'Antony and Cleopatra')).closingDate, '2019-01-19');
  // Single issues cover half a month
  assert.equal(isIssuePeriod(parseTrHeaderDates('X\n1-14 October 2018')), true);
  assert.equal(isIssuePeriod(parseTrHeaderDates('X\n15-31 October 2018')), true);
  assert.equal(isIssuePeriod(parseTrHeaderDates('X\n1-29 February 2024')), true);
  assert.equal(isIssuePeriod(parseTrHeaderDates('X\n1-28 February 2024')), false);
});

test('two equally close page links in one volume year are ambiguous (BRO-5031)', () => {
  const two = [
    { title: 'Company', venue: 'Gielgud (Globe)', link: 'https://www.theatrerecord.com/archive/volume/38/page/100' },
    { title: 'Company', venue: 'Gielgud (Globe)', link: 'https://www.theatrerecord.com/archive/volume/38/page/900' },
  ];
  assert.equal(pickTrForReview(two, { title: 'Company', venue: 'Gielgud Theatre', date: '2018-12-10' }), null);
  assert.equal(pickTrForReview(two.slice(1), { title: 'Company', venue: 'Gielgud Theatre', date: '2018-12-10' })?.link, two[1].link);
});

test('a TR production that closed before the review is an earlier production (BRO-5031)', () => {
  const row = { review: { title: 'A Christmas Carol', venue: 'Old Vic', date: '2018-12-10', url: 'u' },
    tr: { title: 'A Christmas Carol', venue: 'Old Vic', link: 'https://www.theatrerecord.com/archive/volume/38/page/100' },
    header: 'A CHRISTMAS CAROL\nPreviews 24 Nov 2017\nPress Night 04 Dec 2017\nCloses 20 Jan 2018' };
  const [c] = buildReviewLedCandidates({ season: '2018-2019', lookups: [row], shows: [], today: '2026-10-11' });
  assert.equal(c.decision.promotable, false);
  assert.match(c.decision.reason, /closed before the review/);
});

test('a TR production that starts after the review is a later production (BRO-5031)', () => {
  const row = { review: { title: 'A Christmas Carol', venue: 'Old Vic', date: '2018-01-10', url: 'u' },
    tr: { title: 'A Christmas Carol', venue: 'Old Vic', link: 'https://www.theatrerecord.com/archive/volume/38/page/1100' },
    header: 'A CHRISTMAS CAROL\nPreviews 24 Nov 2018\nPress Night 04 Dec 2018' };
  const [c] = buildReviewLedCandidates({ season: '2017-2018', lookups: [row], shows: [], today: '2026-10-11' });
  assert.equal(c.decision.promotable, false);
  assert.match(c.decision.reason, /starts after the review/);
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
  const text = 'previous production\n  COMPANY\nby Stephen Sondheim\nGielgud Theatre\n26 September 2018 – 30 March 2019\nTHE STAGE\n17 October 2018\nreview body here';
  const h = pdfHeaderFor(text, 'Company');
  assert.equal(h, 'COMPANY\n26 September 2018 – 30 March 2019');
  assert.doesNotMatch(h, /review body|Gielgud/);
  assert.equal(pdfHeaderFor(text, 'Follies'), null);
});

const { parseTrHeaderDates, headerFacts, buildReviewLedCandidates } = require('./we-review-led-candidates.js');

test('parseTrHeaderDates: labelled previews and press night win over a range', () => {
  assert.deepEqual(parseTrHeaderDates('Previews from 26 Sep 2018\nPress night: 17 Oct 2018\nUntil 22 Dec 2018'),
    { previewsStartDate: '2018-09-26', openingDate: '2018-10-17', closingDate: '2018-12-22' });
  // A range starting on press night is not the first preview
  assert.deepEqual(parseTrHeaderDates('Opened 17 October 2018\n17 October 2018 – 30 March 2019'),
    { previewsStartDate: null, openingDate: '2018-10-17', closingDate: '2019-03-30' });
});

test('parseTrHeaderDates reads the range shapes TR prints', () => {
  assert.deepEqual(parseTrHeaderDates('Gielgud Theatre 26 September 2018 – 30 March 2019'),
    { previewsStartDate: '2018-09-26', openingDate: null, closingDate: '2019-03-30' });
  assert.deepEqual(parseTrHeaderDates('Wed 26 September to Sat 22 December 2018'),
    { previewsStartDate: '2018-09-26', openingDate: null, closingDate: '2018-12-22' });
  // Year given once, run over New Year
  assert.deepEqual(parseTrHeaderDates('1 December – 23 February 2019'),
    { previewsStartDate: '2018-12-01', openingDate: null, closingDate: '2019-02-23' });
  assert.deepEqual(parseTrHeaderDates('1 – 22 December 2018'),
    { previewsStartDate: '2018-12-01', openingDate: null, closingDate: '2018-12-22' });
});

test('parseTrHeaderDates never reads a range across lines or guesses a year', () => {
  assert.deepEqual(parseTrHeaderDates('17 October 2018\nto be continued 3 May 2019'),
    { previewsStartDate: null, openingDate: null, closingDate: null });
  assert.deepEqual(parseTrHeaderDates('Opened 17 October'), { previewsStartDate: null, openingDate: null, closingDate: null });
  assert.deepEqual(parseTrHeaderDates(null), { previewsStartDate: null, openingDate: null, closingDate: null });
});

test('headerFacts keeps the title lines and date phrases, never the prose around them', () => {
  const prose = 'Marianne Elliott has transformed the show into something new and it opened on 17 October 2018 to tremendous acclaim from almost everyone who saw it';
  const h = headerFacts(`COMPANY\nby Stephen Sondheim\nGielgud Theatre\nCast: Rosalie Craig, Patti LuPone\n26 September 2018 – 30 March 2019\n${prose}`);
  assert.equal(h, 'COMPANY\n26 September 2018 – 30 March 2019\nopened on 17 October 2018');
});

test('pdfHeaderFor ignores a contents line and a two-column heading', () => {
  assert.equal(pdfHeaderFor('HANSARD 1234\nreview prose', 'Hansard'), null);
  assert.equal(pdfHeaderFor('COMPANY     THE STAGE\nprose', 'Company'), null);
});

test('buildReviewLedCandidates files a run that started the season before under that season', () => {
  const review = { title: 'The Real Thing', venue: 'Old Vic', date: '2024-09-04', url: 'https://www.whatsonstage.com/x' };
  const tr = { title: 'The Real Thing', venue: 'The Old Vic, London', link: 'https://www.theatrerecord.com/archive/2024/9/x' };
  const header = 'The Real Thing\nPreviews 22 August 2024\nCloses 26 October 2024';
  const [c] = buildReviewLedCandidates({ season: '2024-2025', lookups: [{ review, tr, header }], shows: [], today: '2026-10-11' });
  assert.equal(c.season, '2023-2024');
  assert.equal(c.decision.promotable, true);
  // August previews, September press night: stays in the season of the press night.
  const [e] = buildReviewLedCandidates({ season: '2024-2025', lookups: [{ review, tr, header: header.replace('\nCloses', '\nPress night 03 September 2024\nCloses') }], shows: [], today: '2026-10-11' });
  assert.equal(e.season, '2024-2025');
  assert.equal(e.decision.promotable, true);
  const old = header.replace('22 August 2024', '22 August 2022');
  const [d] = buildReviewLedCandidates({ season: '2024-2025', lookups: [{ review, tr, header: old }], shows: [], today: '2026-10-11' });
  assert.equal(d.season, '2024-2025');
  assert.equal(d.decision.promotable, false);
});

test('buildReviewLedCandidates names the NT stage from the TR venue', () => {
  const review = { title: 'Coriolanus', venue: 'National Theatre', date: '2024-09-25', url: 'https://www.whatsonstage.com/x' };
  const header = 'Coriolanus\nPreviews 11 September 2024\nCloses 09 November 2024';
  const at = v => buildReviewLedCandidates({ season: '2024-2025', lookups: [{ review, tr: { title: 'Coriolanus', venue: v, link: 'https://www.theatrerecord.com/archive/2024/9/20225-coriolanus' }, header }], shows: [], today: '2026-10-11' })[0].venue;
  assert.equal(at('National Theatre - Olivier Theatre, London'), 'Olivier Theatre');
  assert.equal(at('London, Lyttelton, National'), 'Lyttelton Theatre');
  assert.equal(at('National Theatre, London'), 'National Theatre');
});

test('buildReviewLedCandidates ends a run straddling the March 2020 shutdown on 16 March', () => {
  const review = { title: 'The Upstart Crow', venue: 'Gielgud Theatre', date: '2020-02-18', url: 'https://www.whatsonstage.com/x' };
  const tr = { title: 'The Upstart Crow', venue: 'London, Gielgud', link: 'https://www.theatrerecord.com/archive/volume/40/dest/04_upstart_crow' };
  const header = 'THE UPSTART CROW\nFirst Preview 07 February 2020\nPress Night 17 February 2020\nCloses 25 April 2020';
  const [c] = buildReviewLedCandidates({ season: '2019-2020', lookups: [{ review, tr, header }], shows: [], today: '2026-10-11' });
  assert.equal(c.closingDate, '2020-03-16');
  assert.equal(c.scheduledClosingDate, '2020-04-25');
  const before = header.replace('25 April 2020', '05 March 2020');
  const [d] = buildReviewLedCandidates({ season: '2019-2020', lookups: [{ review, tr, header: before }], shows: [], today: '2026-10-11' });
  assert.equal(d.closingDate, '2020-03-05');
  assert.equal(d.scheduledClosingDate, undefined);
});

test('buildReviewLedCandidates dates from TR only and dedups against shows.json', () => {
  const review = { title: 'Company', venue: 'Gielgud Theatre', date: '2018-10-17', url: COMPANY.url };
  const tr = { title: 'Company', venue: 'Gielgud Theatre, London', link: 'https://www.theatrerecord.com/archive/volume/38/dest/21_company' };
  const header = 'COMPANY\nGielgud Theatre\nPreviews from 26 September 2018\nPress night 17 October 2018\nUntil 30 March 2019';
  const [c] = buildReviewLedCandidates({ season: '2018-2019', lookups: [{ review, tr, header }], shows: [], today: '2026-10-11' });
  assert.equal(c.previewsStartDate, '2018-09-26');
  assert.equal(c.openingDate, '2018-10-17');
  assert.equal(c.closingDate, '2019-03-30');
  assert.equal(c.decision.promotable, true);
  assert.equal(c.sourceUrls.theatreRecord, tr.link);

  const shows = [{ id: 'company-west-end-2018', title: 'Company', venue: 'Gielgud Theatre', market: 'west-end', previewsStartDate: '2018-09-26', openingDate: '2018-10-17', closingDate: '2019-03-30', status: 'closed' }];
  const [dup] = buildReviewLedCandidates({ season: '2018-2019', lookups: [{ review, tr, header }], shows, today: '2026-10-11' });
  assert.match(dup.decision.reason, /already in shows.json/);
  // A same-titled Broadway row the same week is not a duplicate
  const bway = [{ ...shows[0], id: 'company-2018', venue: 'Bernard B. Jacobs Theatre', market: 'broadway' }];
  const [ok] = buildReviewLedCandidates({ season: '2018-2019', lookups: [{ review, tr, header }], shows: bway, today: '2026-10-11' });
  assert.equal(ok.decision.promotable, true);

  const [none] = buildReviewLedCandidates({ season: '2018-2019', lookups: [{ review, tr: null, header: null }], shows: [], today: '2026-10-11' });
  assert.equal(none.decision.reason, 'no Theatre Record production matched');
  assert.equal(none.openingDate, null);
});

// Real 2019-20 lookup (we-historical-tr-resolve run 38123490290): PDF-era
// search results put the city first, "London, Old Vic".
test('pickTrForReview reads PDF-era "London, <venue>" results (A Very Expensive Poison, Upstart Crow)', () => {
  const poison = { title: 'A Very Expensive Poison', venue: 'Old Vic', date: '2019-09-06' };
  const r = [{ title: 'A VERY EXPENSIVE POISON', venue: 'London, Old Vic', link: 'https://www.theatrerecord.com/archive/volume/39/dest/17_a_very_expensive_poison' }];
  assert.equal(trVenueName('London, Old Vic'), 'Old Vic');
  assert.equal(pickTrForReview(r, poison, { isLondonVenue })?.link, r[0].link);
  const crow = { title: 'The Upstart Crow', venue: 'Gielgud Theatre', date: '2020-02-18' };
  const cr = [
    { title: 'The Upstart Crow', venue: 'Apollo Theatre, London', link: 'https://www.theatrerecord.com/archive/2022/9/2636-the-upstart-crow' },
    { title: 'UPSTART CROW', venue: 'London, Gielgud', link: 'https://www.theatrerecord.com/archive/volume/40/dest/04_upstart_crow' },
  ];
  assert.equal(pickTrForReview(cr, crow, { isLondonVenue })?.link, cr[1].link);
});

test('pdfHeaderFor skips the Reviews heading and takes the listing that carries run dates', () => {
  // The first HANSARD heading sits above the reviews (outlet next); the second
  // is the production listing, its venue/date line run into a second column.
  const text = [
    'Reviews', 'HANSARD', 'EVENING STANDARD', 'some review prose here',
    '4 September 2019', 'more prose',
    'HANSARD', 'by Simon Woods',
    'Lyttelton, National Theatre 23 August 2019 – 25 November 2019     an advert in the next column with many many words',
  ].join('\n');
  const h = pdfHeaderFor(text, 'Hansard');
  assert.equal(h, 'HANSARD\n23 August 2019 – 25 November 2019');
  assert.doesNotMatch(h, /advert|prose/);
});

test('headerFacts keeps only the date phrase from a long merged line', () => {
  const h = headerFacts('MASTER HAROLD...AND THE BOYS\nRevival of play written by ATHOL FUGARD\nLyttelton, National Theatre\nExeunt Magazine gives critics the freedom to expand from the tight deadlines; previews from 24 September 2019, opened 1 October 2019, until 8 December 2019 and more words follow');
  assert.equal(h, 'MASTER HAROLD...AND THE BOYS\npreviews from 24 September 2019\nopened 1 October 2019\nuntil 8 December 2019');
  assert.deepEqual(parseTrHeaderDates(h), { previewsStartDate: '2019-09-24', openingDate: '2019-10-01', closingDate: '2019-12-08' });
});

test('a label running into a range keeps the range end (review of c7f7e1bd)', () => {
  assert.deepEqual(parseTrHeaderDates(headerFacts('X\nOpened 17 Oct 2018 – 30 Mar 2019')),
    { previewsStartDate: null, openingDate: '2018-10-17', closingDate: '2019-03-30' });
  assert.deepEqual(parseTrHeaderDates(headerFacts('X\nPreviews from 26 Sep – 22 Dec 2018')),
    { previewsStartDate: '2018-09-26', openingDate: null, closingDate: '2018-12-22' });
});

test('headerFacts never keeps a prose line, and pdfHeaderFor returns null for an undated block', () => {
  const reviewsBlock = 'HANSARD\nMichael Billington, Guardian. The play opened on 12 Sep at the Lyttelton and\nit is a quiet portrait of a marriage\n26 September 2019';
  assert.equal(headerFacts(reviewsBlock), 'HANSARD\nopened on 12 Sep');
  assert.equal(pdfHeaderFor(reviewsBlock, 'Hansard'), null);
  // Under a "Reviews" marker even a dated block is the reviews, not the listing
  assert.equal(pdfHeaderFor('Reviews\nHANSARD\nthe run ends 30 November 2019, says one critic', 'Hansard'), null);
});

test('pdfHeaderFor tries the exact title before a THE-variant (Father vs The Father)', () => {
  const text = 'THE FATHER\n6 October 2015 – 21 November 2015\nFATHER\n2 March 2016 – 9 April 2016';
  assert.equal(pdfHeaderFor(text, 'Father'), 'FATHER\n2 March 2016 – 9 April 2016');
  assert.equal(pdfHeaderFor('THE FATHER\n6 October 2015 – 21 November 2015', 'Father'), 'THE FATHER\n6 October 2015 – 21 November 2015');
});

// Label format seen in the real 2019-20 TR header (A Very Expensive Poison):
// "Press Night 05 Sep 2019" / "Closes 05 Oct 2019".
test('parseTrHeaderDates reads the TR "Press Night" / "Closes" labels', () => {
  assert.deepEqual(parseTrHeaderDates('A VERY EXPENSIVE POISON\nPress Night 05 Sep 2019\nCloses 05 Oct 2019'),
    { previewsStartDate: null, openingDate: '2019-09-05', closingDate: '2019-10-05' });
});

test('htmlHeaderFor reads only lines that start with a run-date label', () => {
  const page = 'The Real Thing\nThe Old Vic Theatre, London\nPress Night 12 Sep 2024\nCloses 26 Oct 2024\nThe Guardian\nThe play opened on 4 September 2024 and runs until 9 November 2024 in a long review sentence.\nUntil the very end it charms';
  assert.equal(htmlHeaderFor('The Real Thing', page), 'The Real Thing\nPress Night 12 Sep 2024\nCloses 26 Oct 2024');
  assert.equal(htmlHeaderFor('X', 'The play opened on 4 September 2024 in a long review sentence that runs on'), null);
});

// Real TR layouts from the 2026-10-11 lookup log: an HTML page puts each label
// on its own line above the date; a -raw PDF prints "Previews / Opens 22 Aug
// 2019"; a -layout PDF prints a row of labels over a row of dates.
test('pairLabelLines joins a label with the date on the next line', () => {
  const page = 'Coriolanus\nNational Theatre - Olivier Theatre, London\n\nFirst Preview\n11 September 2024\nPress Night\n24 September 2024\nLast Performance\n09 November 2024\nReviews';
  assert.equal(htmlHeaderFor('Coriolanus', page), 'Coriolanus\nFirst Preview 11 September 2024\nPress Night 24 September 2024\nCloses 09 November 2024');
  assert.deepEqual(parseTrHeaderDates(htmlHeaderFor('Coriolanus', page)),
    { previewsStartDate: '2024-09-11', openingDate: '2024-09-24', closingDate: '2024-11-09' });
  // An unlabelled date (a review's) stays unpaired and unread.
  assert.equal(htmlHeaderFor('X', 'X\nThe Guardian\n24 September 2024'), null);
});

test('pairLabelLines folds "Previews / Opens" and a -layout label row', () => {
  assert.deepEqual(pairLabelLines(['Previews / Opens 22 Aug 2019']), ['Previews 22 Aug 2019']);
  assert.deepEqual(pairLabelLines(['  First Preview     Press Night      Closes', '  07 February 2020   17 February 2020   25 April 2020']),
    ['First Preview 07 February 2020', 'Press Night 17 February 2020', 'Closes 25 April 2020']);
  const pdf = 'THE UPSTART CROW\nby Ben Elton\nGielgud\n\nFirst Preview     Press Night      Closes\n07 February 2020   17 February 2020   25 April 2020\n\n18 February 2020';
  assert.deepEqual(parseTrHeaderDates(pdfHeaderFor(pdf, 'The Upstart Crow')),
    { previewsStartDate: '2020-02-07', openingDate: '2020-02-17', closingDate: '2020-04-25' });
});

test('pairLabelLines zips a stack of labels over a stack of dates, never just the last label', () => {
  const stacked = 'THE UPSTART CROW\nFirst Preview\nPress Night\nCloses\n07 February 2020\n17 February 2020\n25 April 2020\n\n18 February 2020';
  assert.deepEqual(parseTrHeaderDates(pdfHeaderFor(stacked, 'The Upstart Crow')),
    { previewsStartDate: '2020-02-07', openingDate: '2020-02-17', closingDate: '2020-04-25' });
  // Three labels, one date: ambiguous, nothing paired, nothing read.
  assert.equal(htmlHeaderFor('X', 'X\nFirst Preview\nPress Night\nCloses\n07 February 2020'), null);
  // UK "First Night" is press night; a title heading equal to a label is not paired.
  assert.deepEqual(pairLabelLines(['First Night', '12 March 2019']), ['Press night 12 March 2019']);
  assert.deepEqual(pairLabelLines(['Last night I saw it']), ['Last night I saw it']);
  const pdf = 'OPENING NIGHT\nGielgud\nPress Night\n06 March 2024\n\n07 March 2024';
  assert.equal(parseTrHeaderDates(pdfHeaderFor(pdf, 'Opening Night')).openingDate, '2024-03-06');
});

// The 2024-25 run of the lookup (2026-10-11) logged the real HTML labels:
// "Previews", "Opens/Press Night", "Closes", each over its date. "Opens/Press
// Night" is the press night; "Previews / Opens" stays the previews start.
test('htmlHeaderFor reads the Opens/Press Night label as the press night', () => {
  const page = 'The Importance of Being Earnest\nNational Theatre - Lyttelton Theatre, London\n\nPreviews\n20 November 2024\nOpens/Press Night\n28 November 2024\nCloses\n25 January 2025\nReviews';
  assert.deepEqual(parseTrHeaderDates(htmlHeaderFor('The Importance of Being Earnest', page)),
    { previewsStartDate: '2024-11-20', openingDate: '2024-11-28', closingDate: '2025-01-25' });
  assert.deepEqual(pairLabelLines(['Opens / Press Night', '03 September 2024']), ['Press night 03 September 2024']);
  assert.deepEqual(pairLabelLines(['Previews / Opens', '22 August 2019']), ['Previews 22 August 2019']);
});

test('cleanReviewTitle puts a Theatre Record trailing article back in front (BRO-5851)', () => {
  assert.equal(cleanReviewTitle('Lehman Trilogy (The)'), 'The Lehman Trilogy');
  assert.equal(cleanReviewTitle('Birthday Party, The'), 'The Birthday Party');
  assert.equal(cleanReviewTitle('Majority, (The)'), 'The Majority'); // BRO-5851: 2016-17 TR form
  assert.equal(cleanReviewTitle('Plan A'), 'Plan A');
  assert.equal(cleanReviewTitle('Doll’s House (A)'), 'A Doll’s House');
  assert.equal(cleanReviewTitle('The Theory of Everything'), 'The Theory of Everything');
  assert.equal(cleanReviewTitle('Home, I’m Darling'), 'Home, I’m Darling');
});
