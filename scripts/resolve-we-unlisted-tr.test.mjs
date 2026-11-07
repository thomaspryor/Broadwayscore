import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pdfHeaderFor, pdfContentsRowFor, logDateContext } = require('./resolve-we-unlisted-tr.js');
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

// BRO-5851: 2016-17 TR search results (volume 36/37) as the resolver saved
// them in data/audit/we-historical-review-led-2016-2017.json. Bare West End
// house names, regional houses city-suffixed; 11 of 38 unmatched rows.
test('PDF-era bare West End names, the Theatre Upstairs and "(An)" titles match their 2016-17 review', () => {
  const vol = p => `https://www.theatrerecord.com/archive/volume/${p}`;
  for (const [tr, review] of [
    [{ title: 'Travesties', venue: 'Apollo', link: vol('37/page/156') }, { title: 'Travesties', venue: 'Apollo Theatre', date: '2017-02-15' }],
    [{ title: 'Queen Anne', venue: 'Theatre Royal - Haymarket', link: vol('37/page/738') }, { title: 'Queen Anne', venue: 'Theatre Royal Haymarket', date: '2017-07-11' }],
    [{ title: 'Torn', venue: 'Theatre Upstairs', link: vol('36/page/992') }, { title: 'Torn', venue: 'Royal Court', date: '2016-09-14' }],
    [{ title: 'Bat Out of Hell', venue: 'London Coliseum', link: vol('37/page/675') }, { title: 'Bat Out of Hell', venue: 'Coliseum', date: '2017-06-20' }],
    [{ title: 'Inspector Calls (An)', venue: 'Playhouse', link: vol('36/page/1283') }, { title: 'An Inspector Calls', venue: 'Playhouse Theatre', date: '2016-11-10' }],
  ]) {
    assert.equal(pickTrForReview([tr], review, { isLondonVenue }), tr, review.title);
    assert.equal(pickTrForReview([{ ...tr, link: 'https://www.theatrerecord.com/archive/2017/2/156' }], review, { isLondonVenue }), null, `${review.title} HTML-era`);
  }
  // City-suffixed regional houses stay out, with or without PDF context.
  for (const venue of ['Playhouse - Edinburgh', 'Apollo - Hammersmith', 'Lyric - Hammersmith', 'Palace - Watford', 'Theatre Royal - Brighton']) {
    assert.equal(isLondonVenue(venue, { pdfEra: true }), false, venue);
  }
  for (const venue of ['Apollo', 'Phoenix', 'Playhouse', 'Theatre Upstairs', 'Theatre Royal - Haymarket']) {
    assert.equal(isLondonVenue(venue), false, `${venue} without PDF context`);
  }
  // Brodsky/Baryshnikov played the Hammersmith Apollo: not the Apollo Theatre.
  const hammersmith = { title: 'Brodsky/Baryshnikov', venue: 'Apollo - Hammersmith', link: vol('37/page/495') };
  assert.equal(pickTrForReview([hammersmith], { title: 'Brodsky/Baryshnikov', venue: 'Apollo Theatre', date: '2017-05-08' }, { isLondonVenue }), null);
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

// 2016 contents rows print no years (BRO-5851, pdftotext -raw in the 2016-17
// CI log); the year comes from the issue's own running head.
const contents2016 = [
  'Production Venue Opening Closing Page',
  'THE SEWING GROUP – A new play by EV Crowe Royal Court 16 Nov 23 Dec 1297',
  'THE DRESSER – Revival of the play by Ronald Harwood Duke Of York’s 12 Oct 14 Jan 1143',
  'CATHY – Revival of the play by Ali Taylor Pleasance 13 Oct 15 Oct 1148',
  'NO PERIOD – A row with nothing to anchor its year Arts 05 Oct 1100',
  'The Sewing Group 1297 Theatre Record 04 – 17 November 2016',
  'Deny, Deny, Deny 1232 Theatre Record 21 October – 03 November 2016',
  '1298 The Sewing Group Theatre Record 04 – 17 November 2016',
].join('\n');
const dates2016 = (text, title, page) => parseTrHeaderDates(pdfHeaderFor(text, title, 'x', { page }));

test('2016 yearless contents rows take the year from the issue period; a close before the start rolls over', () => {
  assert.deepEqual(dates2016(contents2016, 'The Sewing Group', 1297), { previewsStartDate: null, openingDate: '2016-11-16', closingDate: '2016-12-23' });
  assert.deepEqual(dates2016(contents2016, 'The Dresser', 1143), { previewsStartDate: null, openingDate: '2016-10-12', closingDate: '2017-01-14' });
  assert.deepEqual(dates2016(contents2016, 'Cathy', 1148), { previewsStartDate: null, openingDate: '2016-10-13', closingDate: '2016-10-15' });
});

test('a yearless row with no issue period, or far from it, fails closed', () => {
  const noBanner = contents2016.split('\n').filter(l => !/Theatre Record/.test(l)).join('\n');
  assert.equal(pdfHeaderFor(noBanner, 'The Sewing Group', 'x', { page: 1297 }), null);
  const farOff = contents2016.replace('16 Nov 23 Dec 1297', '16 Jun 23 Jul 1297');
  assert.equal(pdfHeaderFor(farOff, 'The Sewing Group', 'x', { page: 1297 }), null);
});

test('a January issue period reaches back into December of the year before', () => {
  const text = 'ALADDIN – Pantomime London Palladium 14 Dec 15 Jan 20\nTheatre Record 30 December – 12 January 2017\nTheatre Record 30 December – 12 January 2017';
  assert.deepEqual(dates2016(text, 'Aladdin', 20), { previewsStartDate: null, openingDate: '2016-12-14', closingDate: '2017-01-15' });
});

test('2016 cumulative index row gives press night for the link\'s own volume/page only', () => {
  const index = [
    "NO MAN'S LAND – Revival of play by Harold Pinter Wyndham's 20 Sep 16 36/1005 Corner Shop 0",
    "NO MAN'S LAND – Revival of play by Harold Pinter Wyndham's 01 Jan 08 28/12 Corner Shop 0",
  ].join('\n');
  const at = (vol, page) => parseTrHeaderDates(pdfHeaderFor(index, "No Man's Land", 'x', { volume: vol, page }));
  assert.deepEqual(at(36, 1005), { previewsStartDate: null, openingDate: '2016-09-20', closingDate: null });
  assert.equal(at(36, 999).openingDate, null);
  assert.equal(at(null, 1005).openingDate, null);
});

// Ship-check cases for the yearless reader (BRO-5851).
test('a wrapped yeared row is not cut short at its opening year', () => {
  const text = 'NINE NIGHT – Natasha Gordon National, Dorfman 30 Apr 18\n26 May 18 355';
  assert.deepEqual(dates2016(text, 'Nine Night', 355), { previewsStartDate: null, openingDate: '2018-04-30', closingDate: '2018-05-26' });
});

test('a yearless close that rolls past ten months is dropped, not mis-yeared', () => {
  const typo = contents2016.replace('16 Nov 23 Dec 1297', '16 Nov 14 Nov 1297');
  assert.deepEqual(dates2016(typo, 'The Sewing Group', 1297), { previewsStartDate: null, openingDate: '2016-11-16', closingDate: null });
});

test('two issue banners printed equally often name no issue', () => {
  const tie = `${contents2016}\n1299 Theatre Record 10 – 23 November 2016\n1300 Theatre Record 10 – 23 November 2016`;
  assert.equal(parseTrHeaderDates(pdfHeaderFor(contents2016, 'The Sewing Group', 'x', { page: 1297 })).openingDate, '2016-11-16');
  assert.equal(pdfHeaderFor(tie, 'The Sewing Group', 'x', { page: 1297 }), null);
});

test('the diagnostic log never prints review prose past 90 characters', () => {
  const prose = 'The Sewing Group - EV Crowe’s slight new play at the Royal Court is a curious, quiet piece that never quite finds its feet, says the critic at length here';
  const text = `THE SEWING GROUP\n${prose}\n${prose}\n${prose}\nTHE SEWING GROUP – A new play by EV Crowe Royal Court 16 Nov 23 Dec 1297`;
  const out = [];
  const log = console.log;
  console.log = s => out.push(String(s));
  try { logDateContext(text, 'The Sewing Group', 'raw'); } finally { console.log = log; }
  const rows = out.filter(l => l.includes('title row'));
  assert.equal(rows.length, 1); // the long prose line is skipped; the contents row prints
  assert.ok(rows[0].includes('16 Nov 23 Dec 1297'));
  for (const part of rows[0].split(' || ').slice(1)) assert.ok(part.length <= 90);
});

// BRO-6343: 2015-16 production pages (volumes 35-36) print venue and run ABOVE
// the heading. Synthetic -raw shapes copied from the masked CI probe
// (run 40415845770); parser fixtures, not evidence for production dates.
const { pdfRunHeadFor, resumeKeeps } = require('./resolve-we-unlisted-tr.js');
const runHead = (venueLine, run, heading, credit = 'Revival of the play by JOHN OSBORNE') =>
  `Vol. XXXVI Issue 18\nOpenings 26 Aug - 12 Sep 2016\nProductions 26 Aug - 12 Sep 2016\n\f${venueLine}\n${run}\n${heading}\n${credit}\nKenneth Branagh Archie Rice\n`;

const dates36 = (text, title, venue) => parseTrHeaderDates(pdfHeaderFor(text, title, venue, { volume: 36 }));

test('2015-16 run head above the heading gives press night and close', () => {
  assert.deepEqual(dates36(runHead('GARRICK', '30 August – 12 November 2016', 'THE ENTERTAINER'), 'Entertainer (The)', 'Garrick'), {
    previewsStartDate: null, openingDate: '2016-08-30', closingDate: '2016-11-12',
  });
  assert.deepEqual(dates36(runHead('DOMINION', '21 July 2016 – 07 January 2017', 'THE BODYGUARD'), 'Bodyguard (The)', 'Dominion'), {
    previewsStartDate: null, openingDate: '2016-07-21', closingDate: '2017-01-07',
  });
  assert.deepEqual(dates36(runHead('ROYAL COURT', '22 – 30 July 2016', 'PIGS AND DOGS'), 'Pigs and Dogs', 'Royal Court'), {
    previewsStartDate: null, openingDate: '2016-07-22', closingDate: '2016-07-30',
  });
  assert.deepEqual(dates36(runHead('THEATRE ROYAL HAYMARKET', '27 August- 9 September 2015', 'MR FOOTE\'S OTHER LEG'), "Mr Foote's Other Leg", 'Theatre Royal - Haymarket').openingDate, '2015-08-27');
});

test('a single run-head date is press night only; a squashed year still reads', () => {
  assert.deepEqual(dates36(runHead('ADELPHI', '15 September2015', 'KINKY BOOTS'), 'KINKY BOOTS', 'Adelphi'), {
    previewsStartDate: null, openingDate: '2015-09-15', closingDate: null,
  });
});

test('a run head at another venue is another production', () => {
  const text = runHead('GARRICK', '30 August – 12 November 2016', 'THE ENTERTAINER');
  assert.equal(pdfRunHeadFor(text, 'Entertainer (The)', 'Old Vic'), null);
  assert.equal(pdfRunHeadFor(text, 'Entertainer (The)', null), null);
  assert.equal(pdfRunHeadFor(text, 'The Entertainers', 'Garrick'), null);
});

test('a run head needs the venue line directly above the run line', () => {
  // a lowercase line (prose, a credit) in the venue slot is not a venue
  assert.equal(pdfRunHeadFor('the Garrick, where\n30 August – 12 November 2016\nTHE ENTERTAINER\n', 'Entertainer (The)', 'Garrick'), null);
  // a heading with no run line above it reads nothing from this path
  assert.equal(pdfRunHeadFor('GARRICK\nTHE ENTERTAINER\n30.08.16\n', 'Entertainer (The)', 'Garrick'), null);
});

test('run heads: reversed or impossible ranges and conflicting blocks fail closed', () => {
  assert.equal(pdfRunHeadFor(runHead('GARRICK', '30 November 2016 – 12 August 2016', 'THE ENTERTAINER'), 'Entertainer (The)', 'Garrick'), null);
  assert.equal(pdfRunHeadFor(runHead('GARRICK', '31 February – 12 August 2016', 'THE ENTERTAINER'), 'Entertainer (The)', 'Garrick'), null);
  const two = runHead('GARRICK', '30 August – 12 November 2016', 'THE ENTERTAINER') + runHead('GARRICK', '01 December 2016 – 07 January 2017', 'THE ENTERTAINER');
  assert.equal(pdfRunHeadFor(two, 'Entertainer (The)', 'Garrick'), null);
  const same = runHead('GARRICK', '30 August – 12 November 2016', 'THE ENTERTAINER').repeat(2);
  assert.equal(parseTrHeaderDates(pdfRunHeadFor(same, 'Entertainer (The)', 'Garrick')).closingDate, '2016-11-12');
});

test('a yearless start before its end month rolls back a year', () => {
  assert.deepEqual(dates36(runHead('APOLLO', '15 December – 16 January 2016', 'THE DAZZLE'), 'THE DAZZLE', 'Apollo'), {
    previewsStartDate: null, openingDate: '2015-12-15', closingDate: '2016-01-16',
  });
});

test('the issue period printed under a heading is not a run (Nell Gwynn 2016 shape)', () => {
  const text = 'Openings 12-25 February 2016\nProductions 12-25 February 2016\nNELL GWYNN\n12 - 25 February 2016\nVol. XXXVI Issue 04\n';
  assert.equal(pdfHeaderFor(text, 'NELL GWYNN', 'Apollo', { volume: 36 }), null);
  // the real run head in the same issue wins
  const withRun = `${text}APOLLO\n12 February – 30 April 2016\nNELL GWYNN\nTransfer of the play by JESSICA SWALE\n`;
  assert.deepEqual(dates36(withRun, 'NELL GWYNN', 'Apollo'), { previewsStartDate: null, openingDate: '2016-02-12', closingDate: '2016-04-30' });
});

test('run-head facts promote through the existing historical decision', () => {
  const lookups = [{ review: { title: 'The Entertainer', venue: 'Garrick Theatre', date: '2016-08-31' },
    tr: { title: 'Entertainer (The)', venue: 'Garrick', link: 'https://www.theatrerecord.com/archive/volume/36/page/914' },
    header: pdfHeaderFor(runHead('GARRICK', '30 August – 12 November 2016', 'THE ENTERTAINER'), 'Entertainer (The)', 'Garrick', { volume: 36 }) }];
  const [c] = buildReviewLedCandidates({ season: '2016-2017', lookups, shows: [], today: '2026-10-26' });
  assert.deepEqual([c.openingDate, c.closingDate, c.decision.promotable], ['2016-08-30', '2016-11-12', true]);
});

test('--resume refetches PDF matches without a press night and close, keeps the rest', () => {
  const pdf = 'https://www.theatrerecord.com/archive/volume/36/page/914';
  assert.equal(resumeKeeps({ tr: { link: pdf }, header: null }), false);
  assert.equal(resumeKeeps({ tr: { link: pdf }, header: 'NELL GWYNN\n12 - 25 February 2016' }), false);
  assert.equal(resumeKeeps({ tr: { link: pdf }, header: 'X\n28 Jul - 25 Aug 2016\nopening 28 Jul' }), false);
  assert.equal(resumeKeeps({ tr: { link: pdf }, header: 'GROUNDHOG DAY\nPress night 16 Aug 2016\nCloses 17 Sep 2016' }), true);
  assert.equal(resumeKeeps({ tr: null, header: null }), true);
  assert.equal(resumeKeeps({ tr: { link: 'https://www.theatrerecord.com/archive/2019/1234-x' }, header: null }), true);
  assert.equal(resumeKeeps({ tr: { link: pdf }, header: 'X\nPress night 1 Jan 2016\nCloses 2 Feb 2016', error: 'boom' }), false);
  // 2018-19 headers keep TR's casing; a press night alone (run still open) is final too
  assert.equal(resumeKeeps({ tr: { link: pdf }, header: 'ROSMERSHOLM\nPreviews 24 Apr 2019\nPress Night 02 May 2019\nCloses 20 Jul 2019' }), true);
  assert.equal(resumeKeeps({ tr: { link: pdf }, header: 'KINKY BOOTS\nPress night 15 Sep 2015' }), true);
});

test('run heads: day-only or same-month reversals fail closed, and stop the other paths', () => {
  for (const run of ['30 – 2 July 2016', '30 July – 2 July 2016']) {
    assert.equal(pdfRunHeadFor(runHead('GARRICK', run, 'THE ENTERTAINER'), 'Entertainer (The)', 'Garrick'), null, run);
    assert.equal(pdfHeaderFor(runHead('GARRICK', run, 'THE ENTERTAINER'), 'Entertainer (The)', 'Garrick', { volume: 36 }), null, run);
  }
  // a cross-year start past ~10 months is not trusted either
  assert.equal(pdfRunHeadFor(runHead('GARRICK', '16 November – 14 October 2016', 'THE ENTERTAINER'), 'Entertainer (The)', 'Garrick'), null);
});

test('a regional house with the same name is not the London production', () => {
  assert.equal(pdfRunHeadFor(runHead('ROYAL COURT, LIVERPOOL', '1 September – 30 November 2016', 'PIGS AND DOGS'), 'Pigs and Dogs', 'Royal Court'), null);
});

test('a run head equal to the issue period is not a run', () => {
  assert.equal(pdfRunHeadFor(runHead('GARRICK', '26 Aug - 12 Sep 2016', 'THE ENTERTAINER'), 'Entertainer (The)', 'Garrick'), null);
});

test('conflicting run heads give no header at all, not the downward scan', () => {
  const two = runHead('GARRICK', '1 September – 30 November 2016', 'THE ENTERTAINER') + runHead('GARRICK', '2 September – 30 November 2016', 'THE ENTERTAINER');
  assert.equal(pdfHeaderFor(two, 'Entertainer (The)', 'Garrick', { volume: 36 }), null);
});

test('outside volumes 35-36 explicit labels outrank a run-head shape', () => {
  const text = `GIELGUD\n17 October 2018\nCOMPANY\nPreviews 26 Sep 2018\nPress night 18 Oct 2018\nCloses 22 Dec 2018\n`;
  assert.deepEqual(dates(text, 'Company', 'Gielgud'), { previewsStartDate: '2018-09-26', openingDate: '2018-10-18', closingDate: '2018-12-22' });
  // ...and the run head is still the last fallback there
  assert.equal(dates(runHead('GARRICK', '30 August – 12 November 2016', 'THE ENTERTAINER'), 'Entertainer (The)', 'Garrick').closingDate, '2016-11-12');
});

test('run head reads National stages, Royal Court Downstairs, Found 111 and a postcoded house (BRO-6343)', () => {
  const open = (venueLine, run, heading, title, venue) => dates36(runHead(venueLine, run, heading), title, venue).openingDate;
  assert.equal(open('NATIONAL, OLIVIER', '30 March – 02 June 2016', 'LES BLANCS', 'Les Blancs', 'Olivier'), '2016-03-30');
  assert.equal(open('NATIONAL, TEMPORARY', '16 November 2015- 02 January 2016', 'THE WASP', 'Wasp (The)', 'Temporary - National Theatre'), '2015-11-16');
  assert.equal(open('ROYAL COURT, DOWNSTAIRS', '01 December2015- 01 January 2016', 'LINDA', 'Linda', 'Royal Court'), '2015-12-01');
  assert.equal(open('CENTRAL ST MARTINS, FOUND 111', '15 December 2015 - 30 January 2016', 'THE DAZZLE', 'Dazzle (The)', 'Found 111 (Central St Martins)'), '2015-12-15');
  assert.equal(open('UNION SE1', '28 April- 23 May 2015', 'GREY GARDENS', 'Grey Gardens', 'Union - London SE1'), '2015-04-28');
});

test('run head comma venue still rejects other houses and non-London cities (BRO-6343)', () => {
  const head = venueLine => pdfRunHeadFor(runHead(venueLine, '30 March – 02 June 2016', 'LES BLANCS'), 'Les Blancs', 'Olivier');
  assert.match(head('NATIONAL, OLIVIER'), /^Press night 30 Mar 2016$/m);
  for (const v of ['OLIVIER, LIVERPOOL', 'ROYAL EXCHANGE, OLIVIER STUDIO', 'GARRICK', 'OLIVIER, BRADFORD ALHAMBRA', 'NATIONAL, DUNDEE']) assert.equal(head(v), null, v);
  // A regional city, a second house or a bare studio after the comma is another production.
  const at = (venueLine, venue) => pdfRunHeadFor(runHead(venueLine, '30 March – 02 June 2016', 'LES BLANCS'), 'Les Blancs', venue);
  for (const [v, want] of [['ARTS, CAMBRIDGE', 'Arts'], ['CAMBRIDGE, ARTS', 'Cambridge'], ['SAVOY, GARRICK', 'Garrick'], ['LYRIC, STUDIO', 'Lyric'], ['ROYAL COURT, STUDIO', 'Royal Court'], ['ROYAL COURT, DOWNSTAIRS, LIVERPOOL', 'Royal Court']]) {
    assert.equal(at(v, want), null, v);
  }
  assert.equal(pdfRunHeadFor(runHead('ROYAL COURT, DOWNSTAIRS', '1 September – 30 November 2016', 'PIGS AND DOGS'), 'Pigs and Dogs', 'Almeida'), null);
});
