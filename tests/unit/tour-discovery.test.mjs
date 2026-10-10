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
    key: 'the-wiz-2024', broadwayShowId: 'the-wiz-2024', parentId: 'the-wiz-2024', title: 'The Wiz', type: 'musical', pageClass: 'production', source: 'tourstoyou',
    slug: 'tourstoyou:the-wiz:2025-02-22', url: 'https://tourstoyou.org/shows/the-wiz/',
    tourScheduleSlug: 'the-wiz', segmentStart: '2025-02-22',
  });
  const ended = page([row('Baltimore, MD', 'Hippodrome', 'February 22-March 2, 2025'), row('Detroit, MI', 'Fisher', 'March 4-16, 2025')]);
  assert.equal(runningTourCandidate({ slug: 'the-wiz', scheduleUrl: 'u', html: ended, shows: SHOWS, now: NOW }).skip, 'no tour running now or booked to launch');
  assert.equal(runningTourCandidate({ slug: 'the-wiz', scheduleUrl: 'u', html: '<p>new layout</p>', shows: SHOWS, now: NOW }).skip, 'schedule parsed to no engagements');
  // Since BRO-4931 a title no tracked production carries is classified, not refused: a concert/circus/dance
  // keyword is an event, anything else a standalone candidate waiting to be classified.
  const stomp = runningTourCandidate({ slug: 'stomp', scheduleUrl: 'u', html: running, shows: SHOWS, now: NOW });
  assert.deepEqual([stomp.kind, stomp.candidate], ['event', undefined]);
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

test('a three-engagement regional co-production is not a national tour (Liberation, BRO-4262)', () => {
  const { tooFewStops, MIN_TOUR_STOPS } = require('../../scripts/lib/tour-schedule.js');
  assert.equal(tooFewStops([{}, {}, {}]), true);
  assert.equal(tooFewStops(new Array(MIN_TOUR_STOPS).fill({})), false);
  assert.equal(tooFewStops(undefined), false);
});

test('a tour that launches before its Broadway run takes the upcoming Broadway run as parent (BRO-4924)', () => {
  const shows = [
    { id: 'dirty-dancing-2027', title: 'Dirty Dancing', category: 'broadway', status: 'announced', openingDate: null, unconfirmedStartDate: '2027-02-12' },
    { id: 'dirty-dancing-west-end-2027', title: 'Dirty Dancing', category: 'west-end', status: 'upcoming', openingDate: null },
    { id: 'dirty-dancing-the-classic-story-on-stage-west-end-2026', title: 'Dirty Dancing: The Classic Story on Stage', category: 'off-west-end', status: 'upcoming', openingDate: '2026-10-16' },
  ];
  assert.equal(parentForSlug('dirty-dancing-the-musical', shows, '2026-08-12').id, 'dirty-dancing-2027');
  assert.equal(parentForSlug('dirty-dancing-the-musical', shows, null).id, 'dirty-dancing-2027');
  // Once the Broadway run has an official date after the tour launch, it is still the parent.
  const dated = shows.map(s => s.id === 'dirty-dancing-2027' ? { ...s, openingDate: '2027-03-14', status: 'upcoming' } : s);
  assert.equal(parentForSlug('dirty-dancing-the-musical', dated, '2026-08-12').id, 'dirty-dancing-2027');
  // And after the Broadway run has opened (status open, opening within a year of the tour start).
  const opened = shows.map(s => s.id === 'dirty-dancing-2027' ? { ...s, openingDate: '2027-03-14', status: 'open' } : s);
  assert.equal(parentForSlug('dirty-dancing-the-musical', opened, '2026-08-12').id, 'dirty-dancing-2027');
  // A Broadway run that opened years after the tour started is a different production.
  const farLater = shows.map(s => s.id === 'dirty-dancing-2027' ? { ...s, openingDate: '2031-03-14', status: 'open' } : s);
  assert.equal(parentForSlug('dirty-dancing-the-musical', farLater, '2026-08-12'), null);
});

test('an earlier Broadway production still wins over a Broadway run not yet open, and other future shows are never a fallback', () => {
  const shows = [
    { id: 'the-wiz-2024', title: 'The Wiz', category: 'broadway', status: 'closed', openingDate: '2024-04-17' },
    { id: 'the-wiz-2030', title: 'The Wiz', category: 'broadway', status: 'announced', openingDate: null },
    { id: 'cats-2030', title: 'Cats', category: 'broadway', status: 'open', openingDate: '2030-01-01' },
  ];
  assert.equal(parentForSlug('the-wiz', shows, '2025-02-22').id, 'the-wiz-2024');
  assert.equal(parentForSlug('cats', shows, '2025-02-22'), null, 'a dated production that is not announced/upcoming/previews is not a parent');
});

// ---- BRO-4931: a tour may descend from any market --------------------------

test('Heathers resolves to the US Off-Broadway production, not the London one', () => {
  const shows = [
    { id: 'heathers-the-musical-off-west-end-2026', title: 'Heathers: The Musical', category: 'off-west-end', status: 'closed', openingDate: '2026-07-14' },
    { id: 'heathers-the-musical-off-broadway-2025', title: 'Heathers: The Musical', category: 'off-broadway', status: 'open', openingDate: '2025-06-30' },
  ];
  assert.equal(parentForSlug('heathers-the-musical', shows, '2026-09-20').id, 'heathers-the-musical-off-broadway-2025');
  assert.equal(parentForSlug('heathers', shows, null).id, 'heathers-the-musical-off-broadway-2025');
  // Listed in the other order: priority, not array order, decides.
  assert.equal(parentForSlug('heathers', [...shows].reverse(), '2026-09-20').id, 'heathers-the-musical-off-broadway-2025');
});

test('categories are tried broadway, off-broadway, regional, west-end, off-west-end', () => {
  const mk = (category, openingDate = '2020-01-01') => ({ id: `foo-${category}`, title: 'Foo', category, status: 'closed', openingDate });
  const all = ['off-west-end', 'west-end', 'regional', 'off-broadway', 'broadway'].map(c => mk(c));
  const order = ['broadway', 'off-broadway', 'regional', 'west-end', 'off-west-end'];
  for (let i = 0; i < order.length; i++) {
    const pool = all.filter(s => order.indexOf(s.category) >= i);
    assert.equal(parentForSlug('foo', pool, '2026-01-01').category, order[i]);
  }
});

test('within a category the latest production opened on or before the tour start wins', () => {
  const shows = [
    { id: 'bar-regional-2018', title: 'Bar', category: 'regional', openingDate: '2018-05-01' },
    { id: 'bar-regional-2024', title: 'Bar', category: 'regional', openingDate: '2024-05-01' },
    { id: 'bar-regional-2027', title: 'Bar', category: 'regional', openingDate: '2027-05-01' },
  ];
  assert.equal(parentForSlug('bar', shows, '2026-01-01').id, 'bar-regional-2024');
  assert.equal(parentForSlug('bar', shows, '2020-01-01').id, 'bar-regional-2018');
  assert.equal(parentForSlug('bar', shows, '2016-01-01'), null, 'nothing had opened yet and no Broadway run is ahead');
});

test('a Broadway production still beats a later market, and a subtitled production in another market is not the same show', () => {
  const shows = [
    { id: 'baz-2010', title: 'Baz', category: 'broadway', openingDate: '2010-01-01' },
    { id: 'baz-off-broadway-2024', title: 'Baz', category: 'off-broadway', openingDate: '2024-01-01' },
    { id: 'qux-2019', title: 'Qux: A New Musical', category: 'broadway', openingDate: '2019-01-01' },
    { id: 'qux-the-classic-story-west-end-2022', title: 'Qux: The Classic Story on Stage', category: 'west-end', openingDate: '2022-01-01' },
  ];
  assert.equal(parentForSlug('baz', shows, '2026-01-01').id, 'baz-2010');
  assert.equal(parentForSlug('qux', shows, '2026-01-01').id, 'qux-2019', 'Broadway matches by head');
  assert.equal(parentForSlug('qux', shows.filter(s => s.id !== 'qux-2019'), '2026-01-01'), null, 'a subtitled West End production matches only by whole title');
});

test('a regional run is a parent with no Broadway show at all, once it has opened', () => {
  const shows = [{ id: 'mystic-pizza-regional-2025', title: 'Mystic Pizza', category: 'regional', openingDate: '2025-08-01' }];
  assert.equal(parentForSlug('mystic-pizza', shows, '2026-09-20').id, 'mystic-pizza-regional-2025');
  assert.equal(parentForSlug('mystic-pizza', shows, '2025-01-01'), null, 'a tour that launches before the regional run opened has no parent yet');
});

test('runningTourCandidate names an Off-Broadway show as the tour parent', () => {
  const mex = { id: 'mexodus-off-broadway-2026', title: 'Mexodus', category: 'off-broadway', openingDate: '2026-03-01' };
  const html = page([
    row('Boston, MA', 'Citizens Opera House', 'September 22-27, 2026'),
    row('Hartford, CT', 'The Bushnell', 'September 29-October 4, 2026'),
    row('Providence, RI', 'PPAC', 'October 6-11, 2026'),
  ]);
  const r = runningTourCandidate({ slug: 'mexodus', scheduleUrl: 'https://tourstoyou.org/shows/mexodus/', html, shows: [mex], now: NOW });
  assert.equal(r.candidate && r.candidate.parentId, 'mexodus-off-broadway-2026');
  assert.equal(r.candidate.key, 'mexodus-off-broadway-2026');
  assert.equal(r.candidate.broadwayShowId, undefined, 'broadwayShowId is kept only when the parent IS a Broadway show');
  assert.equal(r.candidate.tourScheduleSlug, 'mexodus');
  assert.equal(r.candidate.pageClass, 'production');
});

// ---- BRO-4931: parentless tours, page classes, candidate keys -----------------

const MARKET_PAGE = page([
  row('Boston, MA', 'Citizens Opera House', 'September 22-27, 2026'),
  row('Hartford, CT', 'The Bushnell', 'September 29-October 4, 2026'),
  row('Providence, RI', 'PPAC', 'October 6-11, 2026'),
  row('Albany, NY', 'Proctors', 'October 13-18, 2026'),
]);
const URL_OF = slug => `https://tourstoyou.org/shows/${slug}/`;

test('a Tours To You page with no tracked production is a standalone candidate keyed page:<slug>, waiting to be classified', () => {
  const r = runningTourCandidate({ slug: 'the-bodyguard', pageTitle: 'The Bodyguard', scheduleUrl: URL_OF('the-bodyguard'), html: MARKET_PAGE, shows: SHOWS, now: NOW });
  assert.deepEqual(r.candidate, {
    key: 'page:the-bodyguard', title: 'The Bodyguard', pageClass: 'unclassified', needsClassification: true, source: 'tourstoyou',
    slug: 'tourstoyou:the-bodyguard:2026-09-22', url: URL_OF('the-bodyguard'), tourScheduleSlug: 'the-bodyguard', segmentStart: '2026-09-22',
  });
  assert.equal(r.candidate.parentId, undefined);
  assert.equal(r.candidate.broadwayShowId, undefined);
});

test('an override makes a parentless page a classified standalone production with its title and type', () => {
  const overrides = { 'the-cat-in-the-hat': { class: 'production', title: "Dr. Seuss' The Cat in the Hat", type: 'musical', reason: 'owner', issue: 'BRO-4931', reviewedAt: '2026-10-09' } };
  const r = runningTourCandidate({ slug: 'the-cat-in-the-hat', pageTitle: 'Dr. Seuss&#8217; The Cat in the Hat', scheduleUrl: URL_OF('the-cat-in-the-hat'), html: MARKET_PAGE, shows: SHOWS, overrides, now: NOW });
  assert.equal(r.candidate.key, 'page:the-cat-in-the-hat');
  assert.deepEqual([r.candidate.title, r.candidate.type, r.candidate.pageClass, r.candidate.needsClassification], ["Dr. Seuss' The Cat in the Hat", 'musical', 'production', undefined]);
});

test('events, aggregators, templates and companies are skipped with their kind, before any schedule is read', () => {
  const tour = { id: 'hamilton-tour-2024', title: 'Hamilton', category: 'tour', tourOf: 'hamilton-2015', tourScheduleSlug: 'hamilton' };
  const shows = [...SHOWS, tour];
  for (const [slug, kind] of [['cirque-holiday', 'event'], ['show-page-template', 'template'], ['hamilton-angelica', 'company']]) {
    const r = runningTourCandidate({ slug, scheduleUrl: URL_OF(slug), html: '', shows, now: NOW });
    assert.equal(r.kind, kind, slug);
    assert.match(r.skip, new RegExp(`^${kind} page`));
  }
  // The skip beats "nothing running": a page with no engagements at all is still told apart.
  assert.equal(runningTourCandidate({ slug: 'some-show', scheduleUrl: 'u', html: '<p>new layout</p>', shows, now: NOW }).kind, 'nothing-running');
});

test('an unclassified page with too few engagements is not worth a question; a classified one is left to the create step', () => {
  const three = page([row('Boston, MA', 'A', 'October 6-11, 2026'), row('Hartford, CT', 'B', 'October 13-18, 2026'), row('Albany, NY', 'C', 'October 20-25, 2026')]);
  const unknown = runningTourCandidate({ slug: 'potted-potter', pageTitle: 'Potted Potter', scheduleUrl: 'u', html: three, shows: SHOWS, now: NOW });
  assert.deepEqual([unknown.kind, unknown.candidate], ['too-few-stops', undefined]);
  const overrides = { 'potted-potter': { class: 'production', title: 'Potted Potter', type: 'play', reason: 'x', issue: 'BRO-4931', reviewedAt: '2026-10-09' } };
  const known = runningTourCandidate({ slug: 'potted-potter', pageTitle: 'Potted Potter', scheduleUrl: 'u', html: three, shows: SHOWS, overrides, now: NOW });
  assert.equal(known.candidate.key, 'page:potted-potter', 'create-tour-entries.js applies tooFewStops to it');
});

test('a standalone tour already tracked (a tour with no tourOf and the same title) is not recorded again', () => {
  const standalone = { id: 'the-bodyguard-tour-2026', title: 'The Bodyguard', category: 'tour', status: 'open', openingDate: '2026-09-22', closingDate: null, tourScheduleSlug: 'the-bodyguard' };
  const r = runningTourCandidate({ slug: 'the-bodyguard', pageTitle: 'The Bodyguard', scheduleUrl: 'u', html: MARKET_PAGE, shows: [...SHOWS, standalone], now: NOW });
  assert.deepEqual([r.kind, r.skip], ['tracked', 'already tracked as the-bodyguard-tour-2026']);
});

test('a title that matches a production which had not opened by the tour is neither parented nor standalone', () => {
  const later = { id: 'foo-regional-2030', title: 'Foo', category: 'regional', openingDate: '2030-05-01' };
  const r = runningTourCandidate({ slug: 'foo', pageTitle: 'Foo', scheduleUrl: 'u', html: MARKET_PAGE, shows: [later], now: NOW });
  assert.equal(r.kind, 'no-parent');
});

test('a Broadway parent keeps broadwayShowId; an Off-Broadway or West End one carries parentId only', () => {
  const westEnd = { id: 'woman-in-black-west-end-1989', title: 'The Woman in Black', category: 'west-end', openingDate: '1989-06-07' };
  // Automatic discovery never picks a UK parent (P1-2): without an override the page is unclassified.
  const auto = runningTourCandidate({ slug: 'the-woman-in-black', pageTitle: 'The Woman in Black', scheduleUrl: 'u', html: MARKET_PAGE, shows: [westEnd], now: NOW });
  assert.equal(auto.candidate.parentId, undefined);
  assert.equal(auto.candidate.needsClassification, true);
  // A person names it in data/tour-page-classes.json.
  const overrides = { 'the-woman-in-black': { class: 'production', parentId: westEnd.id, reason: 'x', issue: 'BRO-4931', reviewedAt: '2026-10-09' } };
  const r = runningTourCandidate({ slug: 'the-woman-in-black', scheduleUrl: 'u', html: MARKET_PAGE, shows: [westEnd], overrides, now: NOW });
  assert.deepEqual([r.candidate.key, r.candidate.parentId, r.candidate.broadwayShowId], ['woman-in-black-west-end-1989', 'woman-in-black-west-end-1989', undefined]);
});

test('P1-2: the Choir of Man, Hamnet and the Mousetrap do not pick London parents; the shared constant is the three US markets', () => {
  const { AUTO_TOUR_PARENT_CATEGORIES, TOUR_PARENT_CATEGORIES } = require('../../scripts/lib/tour-family.js');
  assert.deepEqual(AUTO_TOUR_PARENT_CATEGORIES, ['broadway', 'off-broadway', 'regional']);
  assert.ok(AUTO_TOUR_PARENT_CATEGORIES.every(c => TOUR_PARENT_CATEGORIES.includes(c)));
  const shows = [
    { id: 'the-choir-of-man-off-west-end-2026', title: 'The Choir of Man', category: 'off-west-end', openingDate: '2026-01-01' },
    { id: 'hamnet-west-end-2023', title: 'Hamnet', category: 'west-end', openingDate: '2023-03-01' },
    { id: 'the-mousetrap-west-end-1952', title: 'The Mousetrap', category: 'west-end', openingDate: '1952-11-25' },
  ];
  for (const slug of ['the-choir-of-man', 'hamnet', 'the-mousetrap']) {
    assert.equal(parentForSlug(slug, shows, null, AUTO_TOUR_PARENT_CATEGORIES), null, slug);
    const r = runningTourCandidate({ slug, pageTitle: slug, scheduleUrl: 'u', html: MARKET_PAGE, shows, now: NOW });
    assert.equal(r.candidate && r.candidate.parentId, undefined, slug);
  }
  // The roundup matcher uses the same constant.
  assert.equal(require('../../scripts/lib/tour-roundup-candidate.js').isTourParentCategory('west-end'), false);
  // A manual caller still gets every market (Step A).
  assert.equal(parentForSlug('hamnet', shows, null).id, 'hamnet-west-end-2023');
});

test('candidates dedupe by key: two pages of one standalone show are ambiguous, different standalone shows are not', () => {
  const a = { key: 'page:foo', segmentStart: '2026-09-01', tourScheduleSlug: 'foo' };
  const b = { key: 'page:foo', segmentStart: '2026-11-01', tourScheduleSlug: 'foo-1' };
  const c = { key: 'page:bar', segmentStart: '2026-09-01', tourScheduleSlug: 'bar' };
  const out = dedupeCandidates([a, b, c]);
  assert.deepEqual(out.candidates.map(x => [x.key, Boolean(x.ambiguous)]), [['page:foo', true], ['page:bar', false]]);
  assert.equal(out.ambiguous.length, 1);
  // Old rows with only broadwayShowId still dedupe.
  assert.equal(dedupeCandidates([{ broadwayShowId: 'x-2020', segmentStart: 's' }, { broadwayShowId: 'x-2020', segmentStart: 's' }]).candidates.length, 1);
});

test('a BWW roundup-only row pairs with the Tours To You page it names; two roundups are ambiguous; created rows are left alone', () => {
  const { roundupRowFor } = require('../../scripts/lib/tour-discovery.js');
  const pageRow = { key: 'page:the-bodyguard', title: 'The Bodyguard', tourScheduleSlug: 'the-bodyguard' };
  const roundup = { key: 'roundup:review-roundup-the-bodyguard-launches-national-tour-20261015', source: 'bww-roundup', title: 'The Bodyguard', roundupUrl: 'https://www.broadwayworld.com/article/Review-Roundup-THE-BODYGUARD-Launches-National-Tour-20261015' };
  const other = { key: 'roundup:review-roundup-clue-national-tour-20261001', source: 'bww-roundup', title: 'Clue', roundupUrl: 'https://x/clue' };
  assert.equal(roundupRowFor(pageRow, [other, roundup]), roundup);
  assert.equal(roundupRowFor(pageRow, [other]), null);
  assert.equal(roundupRowFor(pageRow, [roundup, { ...roundup, key: 'roundup:other-slug' }]), null, 'two roundups for one page: none is borrowed');
  assert.equal(roundupRowFor(pageRow, [{ ...roundup, createdTourId: 'x-tour-2025' }]), null);
  // The page slug may differ from the roundup's title ("the-bodyguard-1", "...-the-musical").
  assert.equal(roundupRowFor({ ...pageRow, tourScheduleSlug: 'the-bodyguard-the-musical' }, [roundup]), roundup);
});

test('the pages API asks for each page\'s title and listShowPages keeps it, decoded, beside the slug (BRO-4931)', async () => {
  const { PAGES_API } = require('../../scripts/lib/tour-discovery.js');
  const { listShowPages } = require('../../scripts/lib/tour-discovery.js');
  assert.match(PAGES_API, /_fields=slug,link,modified_gmt,title/);
  const answers = {
    1: JSON.stringify([
      { slug: 'twas-the-night-before', modified_gmt: '2026-07-13T04:00:46', title: { rendered: '&#8216;Twas the Night Before&#8230;' } },
      { slug: 'the-simon-and-garfunkel-story', modified_gmt: '2026-07-01T20:46:47', title: { rendered: 'The Simon &#038; Garfunkel Story' } },
      { slug: 'untitled-page', modified_gmt: '2026-07-01T20:46:47' },
    ]),
  };
  const slugs = await listShowPages(async url => answers[Number(new URL(url).searchParams.get('page'))] || '[]');
  assert.deepEqual([...slugs], ['twas-the-night-before', 'the-simon-and-garfunkel-story', 'untitled-page']);
  assert.equal(slugs.titles['twas-the-night-before'], '‘Twas the Night Before…');
  assert.equal(slugs.titles['the-simon-and-garfunkel-story'], 'The Simon & Garfunkel Story');
  assert.equal('untitled-page' in slugs.titles, false, 'a page with no title is never given one from its URL');
  assert.equal(slugs.modified['twas-the-night-before'], '2026-07-13T04:00:46Z');
});
