import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ref = require('./we-season-reference.js');
const { auditSeason } = require('../audit-we-historical-season.js');

test('parseTheatricaliaDates reads ranges, open runs and single dates', () => {
  assert.deepEqual(ref.parseTheatricaliaDates('15th November 2016 – 11th February 2017'), { start: '2016-11-15', end: '2017-02-11', open: false });
  assert.deepEqual(ref.parseTheatricaliaDates('2nd October – 30th December 2017'), { start: '2017-10-02', end: '2017-12-30', open: false });
  assert.deepEqual(ref.parseTheatricaliaDates('23rd April – July 2013'), { start: '2013-04-23', end: '2013-07-31', open: false });
  assert.deepEqual(ref.parseTheatricaliaDates('1st – 20th June 2015'), { start: '2015-06-01', end: '2015-06-20', open: false });
  assert.deepEqual(ref.parseTheatricaliaDates('started 19th March 2014'), { start: '2014-03-19', end: null, open: true });
  assert.deepEqual(ref.parseTheatricaliaDates('3rd December 2017'), { start: '2017-12-03', end: '2017-12-03', open: false });
  assert.equal(ref.parseTheatricaliaDates('sometime'), null);
});

test('parseTheatricaliaList pulls title, url, dates and companies', () => {
  const html = '<ul><li itemprop="events"><a itemprop="url" href="/play/abc/no-mans-land">No Man&rsquo;s Land</a>'
    + '<span class="meta">8th September – 17th December 2016</span> by <a href="/company/x/foo">Foo Productions</a></li>'
    + '<li itemprop="events"><a itemprop="url" href="/play/def/gala">Gala</a></li></ul>';
  const rows = ref.parseTheatricaliaList(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "No Man's Land");
  assert.equal(rows[0].url, 'https://theatricalia.com/play/abc/no-mans-land');
  assert.equal(rows[0].start, '2016-09-08');
  assert.deepEqual(rows[0].companies, ['Foo Productions']);
  assert.equal(rows[1].start, null);
});

test('titlesMatch allows subtitles but not short-prefix collisions', () => {
  assert.ok(ref.titlesMatch('The Glass Menagerie', 'Glass Menagerie'));
  assert.ok(ref.titlesMatch("Harry Potter and the Cursed Child", 'Harry Potter and the Cursed Child Parts One and Two'));
  assert.ok(!ref.titlesMatch('Cats', 'Cats Eyes Forever'));
  assert.ok(!ref.titlesMatch('Hamlet', 'Macbeth'));
  // Accents fold before the strip, so "Misérables" never shreds to "misrables".
  assert.ok(ref.titlesMatch('Les Misérables', 'Les Miserables'));
  assert.ok(!ref.titlesMatch('Amélie', 'Amlie'));
});

const venueEntries = [{
  venue: 'Harold Pinter Theatre',
  entries: [
    { title: 'Macbeth', start: '2013-02-09', end: '2013-04-27', url: 'u1' },
    { title: 'One Night Gala', start: '2013-03-01', end: '2013-03-02', url: 'u2' },
    { title: 'Solo Thing', start: '2013-05-01', end: '2013-07-01', url: 'u3' },
    { title: 'Last Year Show', start: '2012-05-01', end: '2012-07-01', url: 'u4' },
    { title: 'Macbeth', start: '2013-02-09', end: '2013-04-27', url: 'u1' },
  ],
}];

test('buildSeasonReference keeps in-season runs, drops short runs and dupes, needs a second source', () => {
  const { entries, excluded } = ref.buildSeasonReference({
    season: '2012-2013',
    venueEntries,
    corroborators: [
      { name: 'tr-az', titles: ['Macbeth'] },
      // A Guardian review a year after the run vouches for nothing.
      { name: 'guardian', titles: [{ title: 'Solo Thing', date: '2014-06-01' }] },
    ],
  });
  assert.deepEqual(entries.map(e => e.title), ['Macbeth', 'Solo Thing']);
  assert.deepEqual(entries[0].sources, ['theatricalia', 'tr-az']);
  assert.equal(entries[0].corroborated, true);
  assert.equal(entries[1].corroborated, false);
  assert.equal(excluded.length, 1);
  assert.match(excluded[0].reason, /run of 2 days/);
});

test('buildSeasonReference counts a dated review near the start and the venue article', () => {
  const { entries } = ref.buildSeasonReference({
    season: '2012-2013',
    venueEntries,
    corroborators: [{ name: 'guardian', titles: [{ title: 'Solo Thing', date: '2013-05-10' }] }],
    wikipedia: { 'Harold Pinter Theatre': 'In 2013 the theatre staged Macbeth with James McAvoy.' },
  });
  assert.deepEqual(entries.find(e => e.title === 'Solo Thing').sources, ['theatricalia', 'guardian']);
  assert.deepEqual(entries.find(e => e.title === 'Macbeth').sources, ['theatricalia', 'wikipedia']);
});

const reference = [
  { title: 'Macbeth', venue: 'Harold Pinter Theatre', start: '2013-02-09' },
  { title: 'Top Hat', venue: 'Aldwych Theatre', start: '2013-04-19' },
  { title: 'The Book of Mormon', venue: 'Prince of Wales Theatre', start: '2013-02-25' },
  { title: 'Skylight', venue: 'Wyndham\'s Theatre', start: '2013-06-01' },
];
const shows = [
  { id: 'macbeth-west-end-2013', title: 'Macbeth', category: 'west-end', previewsStartDate: '2013-02-09', openingDate: '2013-02-22' },
  // Long-runner: opened earlier, still running at the reference start.
  { id: 'book-of-mormon-west-end', title: 'The Book of Mormon', category: 'west-end', openingDate: '2013-03-21', previewsStartDate: '2013-02-25' },
  // Same title, wrong production year: not a match.
  { id: 'skylight-west-end-2014', title: 'Skylight', category: 'west-end', openingDate: '2014-06-16', closingDate: '2014-08-23' },
  // Same title on Broadway: not a match.
  { id: 'top-hat-broadway', title: 'Top Hat', category: 'broadway', openingDate: '2013-04-19' },
];

test('referenceCoverage matches by title and date window, west-end rows only', () => {
  const c = ref.referenceCoverage({ reference, shows });
  assert.equal(c.total, 4);
  assert.deepEqual(c.present.map(p => p.showId), ['macbeth-west-end-2013', 'book-of-mormon-west-end']);
  assert.deepEqual(c.missing.map(m => m.title), ['Top Hat', 'Skylight']);
  assert.equal(c.share, 0.5);
  assert.equal(c.pass, false);
  const runSpan = ref.referenceCoverage({
    reference: [{ title: 'Les Misérables', venue: 'Queen\'s Theatre', start: '2014-09-01' }],
    shows: [{ id: 'les-mis', title: 'Les Misérables', category: 'west-end', openingDate: '1985-10-08', closingDate: '2019-07-13' }],
  });
  assert.equal(runSpan.share, 1);
  assert.equal(ref.referenceCoverage({ reference: [], shows }).pass, false);
});

test('auditSeason reports completeness as advisory and never gates on it', () => {
  const promoted = { id: 'p', title: 'Macbeth', category: 'west-end', season: '2012-2013', discoverySource: 'we-historical:wos', images: { poster: 'x' }, synopsis: 'A play.' };
  const reviews = Array.from({ length: 5 }, (_, i) => ({ showId: 'p', outletId: `o${i}`, criticName: `c${i}`, assignedScore: 70 }));
  const withRef = auditSeason({ shows: [...shows, promoted], reviews, season: '2012-2013', reference });
  const withoutRef = auditSeason({ shows: [...shows, promoted], reviews, season: '2012-2013' });
  assert.equal(withRef.checks.completeness.pass, null);
  assert.equal(withRef.checks.completeness.wouldPass, false);
  assert.deepEqual(withRef.checks.completeness.missing.map(m => m.title), ['Top Hat', 'Skylight']);
  assert.equal(withoutRef.checks.completeness.total, 0);
  assert.equal(withRef.pass, withoutRef.pass);
});

test('referenceCandidates turns missing entries into collapsed, unconfirmed-dated candidates', () => {
  const refList = [
    { title: 'Macbeth', venue: 'Harold Pinter Theatre', start: '2013-02-09', end: '2013-04-27', sources: ['theatricalia', 'tr-az'], url: 'https://theatricalia.com/play/x' },
    { title: 'Top Hat', venue: 'Aldwych Theatre', start: '2013-04-19', end: '2013-10-26', sources: ['theatricalia', 'guardian'], url: 'https://theatricalia.com/play/y' },
  ];
  const c = ref.referenceCandidates({ season: '2012-2013', reference: refList, shows });
  assert.equal(c.length, 1);
  assert.equal(c[0].title, 'Top Hat');
  assert.equal(c[0].origin, 'reference');
  assert.equal(c[0].previewsStartDate, '2013-04-19');
  assert.equal(c[0].openingDate, '2013-04-19');
  assert.equal(c[0].openingDateSource, 'theatricalia-first-performance');
  assert.equal(c[0].closingDate, '2013-10-26');
  assert.equal(c[0].sourceUrls.theatricalia, 'https://theatricalia.com/play/y');
});

test('promote-historical-we plans a reference row with the theatricalia source, and the audit flags its opening', () => {
  const { planPromotions } = require('../promote-historical-we.js');
  const cand = ref.referenceCandidates({
    season: '2012-2013',
    reference: [{ title: 'Top Hat', venue: 'Aldwych Theatre', start: '2013-04-19', end: '2013-10-26', sources: ['theatricalia', 'guardian'], url: 'https://theatricalia.com/play/y' }],
    shows,
  });
  const { toPromote } = planPromotions({ candidates: cand, shows, approvals: {}, today: '2026-10-27' });
  assert.equal(toPromote.length, 1);
  const row = toPromote[0];
  assert.equal(row.id, 'top-hat-west-end-2013');
  assert.equal(row.discoverySource, 'we-historical:theatricalia');
  assert.equal(row.openingDateSource, 'theatricalia-first-performance');
  assert.equal(row.closingDateSource, 'theatricalia');
  assert.deepEqual(row.evidenceUrls, ['https://theatricalia.com/play/y']);
  const audit = auditSeason({ shows: [...shows, row], reviews: [], season: '2012-2013' });
  assert.equal(audit.shows, 1);
  assert.deepEqual(audit.checks.opening.rows.map(r => r.showId), ['top-hat-west-end-2013']);
  assert.equal(audit.checks.opening.pass, false);
});

test('referenceCoverage counts a return run of a row already on the site', () => {
  const rows = [{ id: 'kite-2017', title: 'The Kite Runner', category: 'west-end', openingDate: '2017-01-10', closingDate: '2017-03-11' }];
  const c = ref.referenceCoverage({
    reference: [
      { title: 'The Kite Runner', venue: 'Playhouse Theatre', start: '2017-06-08' },
      { title: 'The Kite Runner', venue: 'Playhouse Theatre', start: '2018-06-08' },
    ],
    shows: rows,
  });
  assert.deepEqual(c.present.map(p => p.start), ['2017-06-08']);
  assert.deepEqual(c.missing.map(m => m.start), ['2018-06-08']);
});

test('referenceCandidates adds a production once when the list also carries its return run', () => {
  const c = ref.referenceCandidates({
    season: '2015-2016',
    reference: [
      { title: 'The Father', venue: "Duke of York's Theatre", start: '2016-02-01', end: '2016-03-26', sources: ['theatricalia', 'guardian'] },
      { title: 'The Father', venue: "Wyndham's Theatre", start: '2015-10-05', end: '2015-11-21', sources: ['theatricalia', 'guardian'] },
    ],
    shows: [],
  });
  assert.deepEqual(c.map(x => x.venue), ["Wyndham's Theatre"]);
});

test('titlesMatch keeps possessive and bare-prefix titles apart (ship-check BRO-6450)', () => {
  assert.ok(!ref.titlesMatch("Neville's Island", 'Treasure Island'));
  assert.ok(!ref.titlesMatch("A Doll's House", 'House'));
  assert.ok(!ref.titlesMatch('Top Girls', 'The Girls'));
  assert.ok(!ref.titlesMatch('Lady Macbeth', 'Macbeth'));
  assert.ok(!ref.titlesMatch('& Juliet', 'Romeo and Juliet'));
  assert.ok(!ref.titlesMatch('Wise Children', 'The Children'));
  assert.ok(ref.titlesMatch("Disney's Aladdin", 'Aladdin'));
  assert.ok(ref.titlesMatch("Monty Python's Spamalot", 'Spamalot'));
  assert.ok(ref.titlesMatch('Jersey Boys', 'Jersey Boys: The Story of Frankie Valli'));
});

test('referenceCoverage treats a row with no closing date as still running', () => {
  const c = ref.referenceCoverage({
    reference: [{ title: 'Mamma Mia!', venue: 'Novello Theatre', start: '2012-09-06' }],
    shows: [{ id: 'mamma-mia-west-end', title: 'Mamma Mia!', category: 'west-end', openingDate: '1999-04-06' }],
  });
  assert.equal(c.share, 1);
});

test('buildSeasonReference: a one-night gala listed first does not hide the full run', () => {
  const { entries } = ref.buildSeasonReference({
    season: '2012-2013',
    venueEntries: [{ venue: 'Garrick Theatre', entries: [
      { title: 'Loserville', start: '2013-01-20', end: '2013-01-20', url: 'g' },
      { title: 'Loserville', start: '2012-10-17', end: '2013-01-31', url: 'r' },
    ] }],
    corroborators: [{ name: 'tr-az', titles: ['Loserville'] }],
  });
  assert.deepEqual(entries.map(e => e.url), ['r']);
});
