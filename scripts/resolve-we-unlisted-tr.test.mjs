import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pdfHeaderFor, pdfContentsRowFor } = require('./resolve-we-unlisted-tr.js');
const { parseTrHeaderDates, pickTrForReview, buildReviewLedCandidates } = require('./lib/we-review-led-candidates.js');
const { isLondonVenue } = require('./lib/tr-london-venue.js');

// Synthetic production rows in the 2018 format described by the CI log.
// These are parser fixtures, not evidence for backfilling production dates.
const listing = (row, title = 'COMPANY') => `Issue 19-20 Openings 1-31 October 2018\n${title}\n${row}\nReviews\n${title}\nTHE STAGE\n18 October 2018`;
const dates = (text, title = 'Company', venue = 'Gielgud (Globe)') =>
  parseTrHeaderDates(pdfHeaderFor(text, title, venue));

test('undated PDF block falls back to its title and venue in Openings', () => {
  assert.deepEqual(dates(listing('London, Gielgud 17 Oct 18 30 Mar 19')), {
    previewsStartDate: null, openingDate: '2018-10-17', closingDate: '2019-03-30',
  });
  assert.equal(pdfHeaderFor(listing('London, Gielgud 17 Oct 18 30 Mar 19'), 'Company', 'Gielgud (Globe)'),
    'COMPANY\nPress night 17 Oct 2018\nCloses 30 Mar 2019');
});

test('Openings accepts a pipe separator and yearless closing date over New Year', () => {
  assert.equal(dates(listing('Gielgud 17 Oct 18 | 30 Mar')).closingDate, '2019-03-30');
  assert.equal(dates(listing('Gielgud 17 Oct 2018 | 22 Dec')).closingDate, '2018-12-22');
});

test('postfixed article in the TR search title matches the PDF heading', () => {
  assert.deepEqual(dates(listing("London, Wyndham’s 09 Oct 18 01 Dec", 'THE HEIGHT OF THE STORM'),
    'Height of the Storm (The)', "Wyndham's"), {
    previewsStartDate: null, openingDate: '2018-10-09', closingDate: '2018-12-01',
  });
});

test('Openings facts feed the existing historical promotion decision for both productions', () => {
  const lookups = [
    { review: { title: 'Company', venue: 'Gielgud Theatre', date: '2018-10-17' },
      tr: { title: 'Company', venue: 'Gielgud (Globe)' },
      text: listing('London, Gielgud 17 Oct 18 30 Mar 19') },
    { review: { title: 'The Height of the Storm', venue: "Wyndham's Theatre", date: '2018-10-10' },
      tr: { title: 'Height of the Storm (The)', venue: "Wyndham's" },
      text: listing("London, Wyndham's 09 Oct 18 01 Dec", 'THE HEIGHT OF THE STORM') },
  ].map(row => ({ ...row, header: pdfHeaderFor(row.text, row.tr.title, row.tr.venue) }));
  const candidates = buildReviewLedCandidates({ season: '2018-2019', lookups, shows: [], today: '2026-10-16' });
  assert.deepEqual(candidates.map(c => [c.openingDate, c.closingDate, c.decision.promotable]), [
    ['2018-10-17', '2019-03-30', true], ['2018-10-09', '2018-12-01', true],
  ]);
});

test('Openings start alone supplies press night without inventing a closing date', () => {
  assert.deepEqual(dates(listing('Gielgud 17 Oct 18')), {
    previewsStartDate: null, openingDate: '2018-10-17', closingDate: null,
  });
});

test('dated production block takes precedence over the Openings fallback', () => {
  const text = `COMPANY\nPreviews 26 Sep 2018\nPress night 18 Oct 2018\nCloses 22 Dec 2018\n${listing('Gielgud 17 Oct 18 30 Mar 19')}`;
  assert.equal(dates(text).openingDate, '2018-10-18');
});

test('ordinary PDF header still supports postfixed articles', () => {
  const text = 'THE HEIGHT OF THE STORM\nPress night 09 Oct 2018\nCloses 01 Dec 2018';
  assert.equal(dates(text, 'Height of the Storm (The)', "Wyndham's").openingDate, '2018-10-09');
});

test('Openings requires both the requested title and venue', () => {
  const text = listing('Gielgud 17 Oct 18 30 Mar 19');
  assert.equal(pdfHeaderFor(text, 'Company'), null);
  assert.equal(pdfHeaderFor(text, 'Company', "Wyndham's"), null);
  assert.equal(pdfHeaderFor(text, 'Follies', 'Gielgud'), null);
  const nextTitle = listing('FOLLIES\nGielgud 17 Oct 18 30 Mar 19');
  assert.equal(pdfHeaderFor(nextTitle, 'Company', 'Gielgud'), null);
});

test('Openings reads only the matched venue row in a touring listing', () => {
  // The card quotes this CI diagnostic: "Oldham, Coliseum 25 May 18 | 09 Jun".
  // The logger inserts the pipe before the second date; reconstruct the row.
  const text = listing('Oldham, Coliseum 25 May 18 09 Jun\nLondon, Gielgud 17 Oct 18 30 Mar 19');
  assert.equal(dates(text).openingDate, '2018-10-17');
  assert.equal(pdfHeaderFor(listing('Royal Court, Liverpool 17 Oct 18 30 Mar 19'), 'Company', 'Royal Court'), null);
});

test('Openings never reads review prose or a row outside the Openings section', () => {
  for (const text of [
    'COMPANY\nGielgud 17 Oct 18 30 Mar 19',
    'Openings\nReviews\nCOMPANY\nGielgud 17 Oct 18 30 Mar 19',
    'Openings\nCOMPANY\nThis review says Gielgud 17 Oct 18 30 Mar 19',
  ]) assert.equal(pdfHeaderFor(text, 'Company', 'Gielgud'), null);
});

test('conflicting matched listing rows fail closed; repeated identical rows are safe', () => {
  const text = listing('Gielgud 17 Oct 18 30 Mar 19');
  assert.equal(pdfHeaderFor(`${text}\n${text.replace('17 Oct', '18 Oct')}`, 'Company', 'Gielgud'), null);
  assert.equal(dates(`${text}\n${text}`).openingDate, '2018-10-17');
});

test('Openings rejects impossible dates, missing years and explicit reversed ranges', () => {
  for (const row of [
    'Gielgud 31 Feb 18 30 Mar 19', 'Gielgud 17 Oct 18 31 Feb 19',
    'Gielgud 17 Oct 30 Mar', 'Gielgud 17 Oct 18 30 Mar 18',
  ]) assert.equal(pdfHeaderFor(listing(row), 'Company', 'Gielgud'), null);
});

test('bare Royal Court and Arts are London venues only with PDF-era context', () => {
  for (const venue of ['Royal Court', 'Arts']) {
    assert.equal(isLondonVenue(venue), false);
    assert.equal(isLondonVenue(venue, { pdfEra: true }), true);
  }
  for (const venue of ['Royal Court, Liverpool', 'Liverpool, Royal Court', 'Arts, Cambridge']) {
    assert.equal(isLondonVenue(venue, { pdfEra: true }), false);
  }
});

test('the real production picker passes PDF context without broadening HTML or issue results', () => {
  for (const [title, venue, reviewVenue] of [['The Cane', 'Royal Court', 'Royal Court'], ['Six', 'Arts', 'Arts Theatre']]) {
    const review = { title, venue: reviewVenue, date: '2018-10-17' };
    const pdf = { title, venue, link: 'https://www.theatrerecord.com/archive/volume/38/page/943' };
    assert.equal(pickTrForReview([pdf], review, { isLondonVenue }), pdf);
    for (const link of ['https://www.theatrerecord.com/archive/2018/10/943', 'https://www.theatrerecord.com/archive/issue/943']) {
      assert.equal(pickTrForReview([{ ...pdf, link }], review, { isLondonVenue }), null);
    }
    assert.equal(pickTrForReview([{ ...pdf, venue: `${venue}, Liverpool` }], review, { isLondonVenue }), null);
  }
});

// Contents-table rows as pdftotext -raw printed them in the 2017-18 CI log
// (BRO-5851): Production Venue Opening Closing Page, one row per production.
const contents = [
  'Production Venue Opening Closing Page',
  'MOOD MUSIC – World première of the play by Joe Penhall The Old Vic 02 May 18 16 Jun 18 401',
  'NINE NIGHT – A new play by Natasha Gordon National, Dorfman 30 Apr 18 26 May 18 355',
  'TINA: THE TINA TURNER MUSICAL – A new musical with the songs of Tina Turner, written by Katori',
  'Hall Aldwych 17 Apr 18 321',
  'Mood Music 401',
  'GUARDIAN',
  '03.05.18',
].join('\n');
const contentsDates = (title, page) => parseTrHeaderDates(pdfHeaderFor(contents, title, 'x', { page }));

test('2017-18 contents row gives press night and closing for the linked page', () => {
  assert.deepEqual(contentsDates('Mood Music', 401), { previewsStartDate: null, openingDate: '2018-05-02', closingDate: '2018-06-16' });
  assert.deepEqual(contentsDates('Nine Night', 355), { previewsStartDate: null, openingDate: '2018-04-30', closingDate: '2018-05-26' });
});

test('contents row on a different page is a different production', () => {
  assert.deepEqual(contentsDates('Nine Night', 999), { previewsStartDate: null, openingDate: null, closingDate: null });
});

test('wrapped contents row is joined; a missing closing date stays missing', () => {
  assert.deepEqual(contentsDates('Tina: The Tina Turner Musical', 321), { previewsStartDate: null, openingDate: '2018-04-17', closingDate: null });
});

test('two contents rows for one title without a page fail closed', () => {
  const twice = `${contents}\nMOOD MUSIC – Return of the play The Old Vic 01 Sep 18 01 Oct 18 700`;
  assert.equal(pdfHeaderFor(twice, 'Mood Music', 'x', { page: null }), null);
  assert.equal(parseTrHeaderDates(pdfHeaderFor(twice, 'Mood Music', 'x', { page: 700 })).openingDate, '2018-09-01');
});

// Ship-check cases (BRO-5851): each read another row's dates before the guards.
test('without a page the contents path is skipped', () => {
  assert.equal(pdfContentsRowFor(contents, 'Mood Music', [], null), null);
});

test('a dateless row does not absorb a review byline', () => {
  const text = 'CATS – Revival TBC 401\nMichael Billington, Guardian 1 May 18 401';
  assert.equal(pdfContentsRowFor(text, 'Cats', [], 401), null);
});

test('two -layout columns on one line fail closed', () => {
  const text = 'MOOD MUSIC – Joe Penhall The Old Vic 02 May 18 16 Jun 18 401      NINE NIGHT – Natasha Gordon National, Dorfman 30 Apr 18 26 May 18 355';
  assert.equal(pdfContentsRowFor(text, 'Mood Music', [], 355), null);
  assert.equal(pdfContentsRowFor(text, 'Mood Music', [], 401), null);
});

test('a year after the current one is rejected', () => {
  assert.equal(pdfContentsRowFor('KING LEAR – Revival Duke of York’s 26 May 97 401', 'King Lear', [], 401), null);
});
