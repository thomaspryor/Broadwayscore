import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { titleKey, titleKeys, slugKey, parentForSlug, runningTourCandidate, dedupeCandidates, upcomingSegments } = require('../../scripts/lib/tour-discovery.js');
const { decideTourDates, segmentLaunch, segmentTourRows, parseTourSchedule } = require('../../scripts/lib/tour-schedule.js');
const { openTourCandidates } = require('../../scripts/lib/tour-roundup-candidate.js');
const { buildTourEntry } = require('../../scripts/lib/tour-entry.js');

const row = (city, venue, dates) => `<tr><td>${city}</td><td>${venue}</td><td>${dates}</td><td>2025-2026</td></tr>`;
const page = rows => `<table><tr><th>Location</th><th>Venue</th><th>Dates</th><th>Season</th></tr>${rows.join('')}</table>`;
const NOW = new Date('2026-09-29T00:00:00Z');

const SHOWS = [
  { id: 'moulin-rouge-2019', title: 'Moulin Rouge! The Musical', category: 'broadway', openingDate: '2019-07-25' },
  { id: 'a-beautiful-noise-the-neil-diamond-musical-2022', title: 'A Beautiful Noise, The Neil Diamond Musical', category: 'broadway', openingDate: '2022-12-04' },
  { id: 'the-wiz-1975', title: 'The Wiz', category: 'broadway', openingDate: '1975-01-05' },
  { id: 'the-wiz-2024', title: 'The Wiz', category: 'broadway', openingDate: '2024-04-17' },
  { id: 'the-wiz-2030', title: 'The Wiz', category: 'broadway', openingDate: '2030-01-01' },
  { id: 'the-wiz-westend', title: 'The Wiz', category: 'westend', openingDate: '2025-01-01' },
  { id: 'les-miserables-1987', title: 'Les Miserables', category: 'broadway', openingDate: '1987-03-12' },
  { id: 'les-miserables-2014', title: 'Les Misérables', category: 'broadway', openingDate: '2014-03-23' },
  { id: 'cinderella-2013', title: "Rodgers + Hammerstein's Cinderella", category: 'broadway', openingDate: '2013-03-03' },
];

test('title keys fold subtitles, "The Musical", diacritics and presenter prefixes', () => {
  assert.equal(titleKey('Moulin Rouge! The Musical'), 'moulin-rouge');
  assert.equal(slugKey('moulin-rouge-the-musical'), 'moulin-rouge');
  assert.equal(slugKey('jersey-boys-1'), 'jersey-boys', 'WordPress dedupe suffix');
  assert.equal(slugKey('legally-blonde-the-musical-2'), 'legally-blonde');
  assert.ok(titleKeys('A Beautiful Noise, The Neil Diamond Musical').has('a-beautiful-noise'));
  assert.ok(titleKeys('Two Strangers (Carry a Cake Across New York)').has('two-strangers'));
  assert.equal(titleKey('Les Misérables'), titleKey('Les Miserables'));
  assert.equal(slugKey('cinderella-1'), titleKey("Rodgers + Hammerstein's Cinderella"));
  // A company page is not the title.
  assert.notEqual(slugKey('hamilton-angelica'), titleKey('Hamilton'));
});

test('parent is the latest Broadway production before the tour, never another market', () => {
  assert.equal(parentForSlug('the-wiz', SHOWS, '2025-02-22').id, 'the-wiz-2024');
  assert.equal(parentForSlug('the-wiz', SHOWS, '2023-01-01').id, 'the-wiz-1975', 'a revival after the tour started is not its parent');
  assert.equal(parentForSlug('les-miserables-1', SHOWS, '2026-01-01').id, 'les-miserables-2014');
  assert.equal(parentForSlug('a-beautiful-noise', SHOWS, '2024-09-21').id, 'a-beautiful-noise-the-neil-diamond-musical-2022');
  assert.equal(parentForSlug('blue-man-group', SHOWS, '2026-01-01'), null);
});

test('a running tour is a candidate; a finished or not-yet-listed one is not', () => {
  const running = page([
    row('Baltimore, MD', 'Hippodrome', 'February 22-March 2, 2025'),
    row('Detroit, MI', 'Fisher', 'March 4-16, 2025'),
    row('Boston, MA', 'Citizens Bank', 'August 1-12, 2025'),
    row('Denver, CO', 'Buell', 'January 6-18, 2026'),
    row('Seattle, WA', 'Paramount', 'June 2-14, 2026'),
    row('Portland, OR', 'Keller', 'October 1-12, 2026'),
  ]);
  const r = runningTourCandidate({ slug: 'the-wiz', scheduleUrl: 'https://tourstoyou.org/shows/the-wiz/', html: running, shows: SHOWS, now: NOW });
  assert.deepEqual(r.candidate, {
    broadwayShowId: 'the-wiz-2024', title: 'The Wiz', source: 'tourstoyou',
    slug: 'tourstoyou:the-wiz:2025-02-22', url: 'https://tourstoyou.org/shows/the-wiz/',
    tourScheduleSlug: 'the-wiz', segmentStart: '2025-02-22',
  });
  const ended = page([row('Baltimore, MD', 'Hippodrome', 'February 22-March 2, 2025'), row('Detroit, MI', 'Fisher', 'March 4-16, 2025')]);
  assert.equal(runningTourCandidate({ slug: 'the-wiz', scheduleUrl: 'u', html: ended, shows: SHOWS, now: NOW }).skip, 'no tour running now or booked to launch');
  assert.equal(runningTourCandidate({ slug: 'the-wiz', scheduleUrl: 'u', html: '<p>new layout</p>', shows: SHOWS, now: NOW }).skip, 'schedule parsed to no engagements');
  assert.equal(runningTourCandidate({ slug: 'stomp', scheduleUrl: 'u', html: running, shows: SHOWS, now: NOW }).skip, 'no Broadway show of this title');
});

test('two pages running the same show from different starts are ambiguous', () => {
  const a = { broadwayShowId: 'hamilton-2015', segmentStart: '2020-09-22', tourScheduleSlug: 'hamilton' };
  const b = { broadwayShowId: 'hamilton-2015', segmentStart: '2023-01-10', tourScheduleSlug: 'hamilton-1' };
  const c = { broadwayShowId: 'jersey-boys-2005', segmentStart: '2026-09-08', tourScheduleSlug: 'jersey-boys' };
  const d = { broadwayShowId: 'jersey-boys-2005', segmentStart: '2026-09-08', tourScheduleSlug: 'jersey-boys-1' };
  const out = dedupeCandidates([a, b, c, d]);
  assert.deepEqual(out.candidates.map(x => [x.broadwayShowId, Boolean(x.ambiguous)]), [['hamilton-2015', true], ['jersey-boys-2005', false]],
    'two companies are kept as one ambiguous row for the owner; the same tour on two pages is one plain candidate');
  assert.equal(out.ambiguous.length, 1);
});

test('launch: citation dates never count; a stop in a table is not a launch', () => {
  const seg = segmentTourRows(parseTourSchedule(page([
    row('Providence, RI', 'PPAC', 'September 20-27, 2026'),
    row('Boston, MA', 'Emerson', 'September 29-October 11, 2026'),
  ])))[0];
  // Come From Away: the date sat in a citation's access-date.
  const cite = 'A North American tour began.<ref>{{Cite web |title=Tour |access-date=September 20, 2026}}</ref>';
  assert.equal(segmentLaunch(seg, cite), null);
  // Harry Potter: a table row naming the date without a launch word.
  const table = 'North American tour stops: |Providence |20 September 2026 |27 September 2026';
  assert.equal(segmentLaunch(seg, table), null);
  const prose = 'The North American tour began on September 20, 2026 at PPAC in Providence.';
  assert.equal(segmentLaunch(seg, prose).toISOString().slice(0, 10), '2026-09-20');
});

test('launch: opening night inside the first engagement, or the city with its month or season', () => {
  const seg = segmentTourRows(parseTourSchedule(page([
    row('Baltimore, MD', 'Hippodrome', 'September 27-October 5, 2025'),
    row('Chicago, IL', 'Cadillac Palace', 'October 8-26, 2025'),
  ])))[0];
  const iso = d => d && d.toISOString().slice(0, 10);
  assert.equal(iso(segmentLaunch(seg, 'The United States national tour premiered on September 30, 2025 at the Hippodrome.')), '2025-09-27');
  assert.equal(iso(segmentLaunch(seg, 'A national tour began in September 2025, starting from the Hippodrome Theatre in Baltimore.')), '2025-09-27');
  assert.equal(iso(segmentLaunch(seg, 'A North American tour is planned to launch in fall of 2025 in Baltimore.')), '2025-09-27');
  // Beauty and the Beast: right city, wrong month.
  assert.equal(segmentLaunch(seg, 'A new North American tour opened in June 2025 in Baltimore.'), null);
  // A bare year is not enough.
  assert.equal(segmentLaunch(seg, 'The tour will launch in Baltimore in 2025.'), null);
  // A later stop mentioned without a launch word is not the launch.
  assert.equal(segmentLaunch(seg, 'The tour played Chicago in October 2025.'), null);
});

test('a discovered tour is decided by its segment start and built with schedule evidence', () => {
  const html = page([
    row('Cleveland, OH', 'Playhouse Square', 'October 10-26, 2025'),
    row('Detroit, MI', 'Fisher', 'October 28-November 9, 2025'),
  ]);
  const wiki = 'A touring production of the musical began at Playhouse Square in Cleveland, Ohio on October 10, 2025.';
  const d = decideTourDates({ id: null, title: "Hell's Kitchen", openingDate: null, closingDate: null }, html, wiki, NOW, { segmentStart: '2025-10-10' });
  assert.deepEqual(d.write, { openingDate: '2025-10-10' });
  const parent = { id: 'hells-kitchen-2024', title: "Hell's Kitchen", category: 'broadway', type: 'musical', images: {} };
  const built = buildTourEntry({ parent, shows: [parent], decision: d, roundupUrl: null, scheduleUrl: 'https://tourstoyou.org/shows/hells-kitchen/', now: NOW });
  assert.equal(built.entry.id, 'hells-kitchen-tour-2025');
  assert.equal(built.entry.discoverySource, 'tour-schedule:tourstoyou');
  assert.match(built.entry.tourLaunchEvidence, /tourstoyou\.org\/shows\/hells-kitchen/);
  assert.equal(built.entry.status, 'open');
  assert.equal(built.entry.tourScheduleSlug, 'hells-kitchen', 'the date job reads the same page, never a guess');
  assert.equal(buildTourEntry({ parent, shows: [parent], decision: d, now: NOW }).skip, 'no evidence URL (roundup or schedule)');
});

test('a discovered row stays open until its show has a running tour', () => {
  const parent = { id: 'hells-kitchen-2024', title: "Hell's Kitchen", category: 'broadway' };
  const row1 = { broadwayShowId: parent.id, title: parent.title, source: 'tourstoyou', slug: 'tourstoyou:hells-kitchen:2025-10-10' };
  assert.equal(openTourCandidates([row1], [parent]).length, 1);
  const tour = { id: 'hells-kitchen-tour-2025', category: 'tour', tourOf: parent.id, status: 'open' };
  assert.equal(openTourCandidates([row1], [parent, tour]).length, 0);
});

test('ship-check: the whole title wins over a subtitle head; a numbered title is tried whole', () => {
  const shows = [
    { id: 'cats-1982', title: 'Cats', category: 'broadway', openingDate: '1982-10-07' },
    { id: 'cats-the-jellicle-ball-2026', title: 'CATS: The Jellicle Ball', category: 'broadway', openingDate: '2026-04-01' },
    { id: '9-to-5-2009', title: '9 to 5', category: 'broadway', openingDate: '2009-04-30' },
  ];
  assert.equal(parentForSlug('cats', shows, '2026-10-01').id, 'cats-1982');
  assert.equal(parentForSlug('9-to-5-the-musical', shows, '2026-10-01').id, '9-to-5-2009');
});

test('ship-check: a segment an existing tour covers is not recorded again; an ended one is not running', () => {
  const shows = [
    { id: 'hells-kitchen-2024', title: "Hell's Kitchen", category: 'broadway', openingDate: '2024-04-20' },
    { id: 'hells-kitchen-tour-2025', title: "Hell's Kitchen", category: 'tour', tourOf: 'hells-kitchen-2024', openingDate: '2025-10-10', closingDate: null },
  ];
  const html = page([
    row('Cleveland, OH', 'Playhouse Square', 'October 10-26, 2025'),
    row('Chicago, IL', 'Nederlander', 'March 3-22, 2026'),
    row('Denver, CO', 'Buell', 'August 4-16, 2026'),
    row('Detroit, MI', 'Fisher', 'September 20-October 30, 2026'),
  ]);
  assert.equal(runningTourCandidate({ slug: 'hells-kitchen', scheduleUrl: 'u', html, shows, now: NOW }).skip, 'already tracked as hells-kitchen-tour-2025');
  const ended = page([row('Cleveland, OH', 'Playhouse Square', 'August 1-10, 2026'), row('Detroit, MI', 'Fisher', 'September 1-20, 2026')]);
  assert.equal(runningTourCandidate({ slug: 'hells-kitchen', scheduleUrl: 'u', html: ended, shows: shows.slice(0, 1), now: NOW }).skip, 'no tour running now or booked to launch');
});

test('ship-check: another country\'s tour is never launch evidence; a UK sentence nearby does not block', () => {
  const seg = segmentTourRows(parseTourSchedule(page([
    row('Birmingham, AL', 'BJCC', 'March 10-15, 2026'),
    row('Atlanta, GA', 'Fox', 'March 17-29, 2026'),
  ])))[0];
  assert.equal(segmentLaunch(seg, 'The UK tour began in March 2026 in Birmingham.'), null);
  assert.equal(segmentLaunch(seg, 'The Australian tour opened on March 14, 2026.'), null);
  const both = 'The UK tour began in Leeds in 2025. The North American tour began on March 10, 2026 in Birmingham, Alabama.';
  assert.equal(segmentLaunch(seg, both).toISOString().slice(0, 10), '2026-03-10');
});

test('ship-check: opening night counts only in the first week of the first engagement', () => {
  const seg = segmentTourRows(parseTourSchedule(page([
    row('Toronto, ON', 'Ed Mirvish', 'March 1-June 30, 2026'),
    row('Boston, MA', 'Emerson', 'July 7-19, 2026'),
  ])))[0];
  assert.equal(segmentLaunch(seg, 'The tour opened on May 14, 2026.'), null);
  assert.equal(segmentLaunch(seg, 'The tour opened on March 5, 2026 in Toronto.').toISOString().slice(0, 10), '2026-03-01');
});

test('ship-check: an ambiguous row clears when the tour is no longer ambiguous', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { recordTourCandidates } = require('../../scripts/lib/tour-roundup-candidate.js');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tourcand-')), 'c.json');
  const base = { broadwayShowId: 'six-2021', title: 'SIX', source: 'tourstoyou', slug: 'tourstoyou:six-the-musical:2022-03-29', segmentStart: '2022-03-29' };
  recordTourCandidates(file, [{ ...base, ambiguous: 'six-2021: two' }], '2026-09-01T00:00:00Z');
  recordTourCandidates(file, [base], '2026-09-02T00:00:00Z');
  const [row1] = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(row1.ambiguous, undefined);
  assert.equal(row1.firstSeen, '2026-09-01T00:00:00Z', 'same slug keeps firstSeen');
});

test('New-York-only aggregators never take a national tour (BRO-4325: NYC Theatre filed Broadway excerpts as tour reviews)', () => {
  const { withoutTours } = require('../../scripts/lib/tour-family.js');
  const out = withoutTours([
    { id: 'maybe-happy-ending-2024', category: 'broadway' },
    { id: 'maybe-happy-ending-tour-2026', category: 'tour' },
    { id: 'oh-mary-2024' },
  ]);
  assert.deepEqual(out.kept.map(s => s.id), ['maybe-happy-ending-2024', 'oh-mary-2024']);
  assert.deepEqual(out.tours.map(s => s.id), ['maybe-happy-ending-tour-2026']);
});

test('a tour booked ahead is a candidate before it opens', () => {
  const booked = page([
    row('Cerritos, CA', 'Cerritos Center', 'January 19-24, 2027'),
    row('Phoenix, AZ', 'Orpheum', 'January 26-31, 2027'),
    row('Denver, CO', 'Buell', 'February 2-14, 2027'),
  ]);
  const r = runningTourCandidate({ slug: 'the-wiz', scheduleUrl: 'u', html: booked, shows: SHOWS, now: NOW });
  assert.equal(r.candidate.segmentStart, '2027-01-19');
  assert.equal(r.candidate.upcoming, true);
  // Beyond UPCOMING_DAYS, or one city only (a sit-down run): not yet.
  const far = page([row('Cerritos, CA', 'C', 'January 19-24, 2028'), row('Phoenix, AZ', 'O', 'January 26-31, 2028'), row('Denver, CO', 'B', 'February 2-14, 2028')]);
  assert.match(runningTourCandidate({ slug: 'the-wiz', scheduleUrl: 'u', html: far, shows: SHOWS, now: NOW }).skip, /booked to launch/);
  const sitDown = page([row('Chicago, IL', 'CIBC', 'January 5-17, 2027'), row('Chicago, IL', 'CIBC', 'January 19-31, 2027'), row('Chicago, IL', 'CIBC', 'February 2-14, 2027')]);
  assert.match(runningTourCandidate({ slug: 'the-wiz', scheduleUrl: 'u', html: sitDown, shows: SHOWS, now: NOW }).skip, /booked to launch/);
  assert.equal(upcomingSegments([], NOW).length, 0);
});

test('a page whose current tour is tracked still yields the next one booked', () => {
  // Shucked: first tour tracked, closed June 2026; second booked from January 2027.
  const closedFirst = page([
    row('Baltimore, MD', 'Hippodrome', 'February 22-March 2, 2025'),
    row('Detroit, MI', 'Fisher', 'March 4-16, 2025'),
    row('Boston, MA', 'Citizens Bank', 'June 1-7, 2026'),
    row('Fort Wayne, IN', 'Embassy', 'January 12, 2027'),
    row('Toledo, OH', 'Stranahan', 'January 14-16, 2027'),
    row('Akron, OH', 'EJ Thomas', 'January 19-21, 2027'),
  ]);
  const first = { id: 'the-wiz-tour-2025', title: 'The Wiz', category: 'tour', tourOf: 'the-wiz-2024', openingDate: '2025-02-22', closingDate: '2026-06-07', status: 'closed' };
  const r = runningTourCandidate({ slug: 'the-wiz', scheduleUrl: 'u', html: closedFirst, shows: [...SHOWS, first], now: NOW });
  assert.equal(r.candidate && r.candidate.segmentStart, '2027-01-12');
  assert.equal(r.candidate.upcoming, true);
  // A running tracked tour, and another booked after a long layoff.
  const runningThenBooked = page([
    row('Baltimore, MD', 'Hippodrome', 'February 22-March 2, 2025'),
    row('Detroit, MI', 'Fisher', 'March 4-16, 2025'),
    row('Boston, MA', 'Citizens Bank', 'October 1-12, 2026'),
    row('Tampa, FL', 'Straz', 'May 4-9, 2027'),
    row('Miami, FL', 'Arsht', 'May 11-16, 2027'),
    row('Orlando, FL', 'Dr. Phillips', 'May 18-23, 2027'),
  ]);
  const running = { ...first, closingDate: '2026-10-12', status: 'open' };
  const r2 = runningTourCandidate({ slug: 'the-wiz', scheduleUrl: 'u', html: runningThenBooked, shows: [...SHOWS, running], now: NOW });
  assert.equal(r2.candidate && r2.candidate.segmentStart, '2027-05-04');
  // Nothing new when both are tracked.
  const later = { ...first, id: 'the-wiz-tour-2027', openingDate: '2027-05-04', closingDate: null, status: 'upcoming' };
  assert.match(runningTourCandidate({ slug: 'the-wiz', scheduleUrl: 'u', html: runningThenBooked, shows: [...SHOWS, running, later], now: NOW }).skip, /already tracked/);
});
