// BRO-4724: a tour's later life on one Tours To You page (layoffs, a second
// company, a corrected page), and tour launches kept out of the Broadway
// opening-night pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { tourHistoryLabels, isSeparateTour, splitSegmentsAt, distinctWorksOfTitle } = require('../../scripts/lib/tour-history.js');
const { lifecyclePlan, reopenBlocker, runningTourCandidate } = require('../../scripts/lib/tour-discovery.js');
const { parseTourSchedule, segmentTourRows, decideTourDates, duplicateScheduleOf } = require('../../scripts/lib/tour-schedule.js');
const { openTourCandidates, recordTourCandidates, tourCandidateFor } = require('../../scripts/lib/tour-roundup-candidate.js');
const { buildTourEntry } = require('../../scripts/lib/tour-entry.js');
const { reopenTour } = require('../../scripts/create-tour-entries.js');
const { earlierClosings } = require('../../scripts/enrich-tour-dates.js');
const { splitOpenedShows } = require('../../scripts/update-show-status.js');
const { isOpeningNightTarget } = require('../../scripts/lib/opening-night-target.js');

const row = (city, venue, dates) => `<tr><td>${city}</td><td>${venue}</td><td>${dates}</td><td>2025-2026</td></tr>`;
const table = rows => `<table><tr><th>Location</th><th>Venue</th><th>Dates</th><th>Season</th></tr>${rows.join('')}</table>`;
// The History tab as Tours To You renders it (elementor tabs).
const history = labels => `<div class="elementor-tab-title"><strong>History</strong></div><div>${labels.map(l => `<p>${l}</p>`).join('')}</div><div id="elementor-tab-content-3">Union status: Equity</div>`;
const NOW = new Date('2026-10-05T12:00:00Z');

// A Beautiful Noise: first tour closed 2026-07-12, the page resumes 2026-10-30
// (110 days later, so one 180-day segment).
const NOISE_ROWS = [
  row('Providence, RI', 'PPAC', 'September 21-29, 2024'),
  row('Boston, MA', 'Citizens Bank', 'October 1-13, 2024'),
  row('Denver, CO', 'Buell', 'January 7-19, 2025'),
  row('Chicago, IL', 'Cadillac', 'June 3-15, 2025'),
  row('Dallas, TX', 'Winspear', 'December 2-14, 2025'),
  row('Houston, TX', 'Hobby', 'March 3-15, 2026'),
  row('Tampa, FL', 'Straz', 'July 1-12, 2026'),
  row('Durham, NC', 'DPAC', 'October 30-November 8, 2026'),
  row('Atlanta, GA', 'Fox', 'November 10-22, 2026'),
  row('Nashville, TN', 'TPAC', 'December 1-13, 2026'),
];
const NOISE_PARENT = { id: 'a-beautiful-noise-the-neil-diamond-musical-2022', title: 'A Beautiful Noise, The Neil Diamond Musical', category: 'broadway', type: 'musical', openingDate: '2022-12-04', images: {} };
const NOISE_TOUR = { id: 'a-beautiful-noise-the-neil-diamond-musical-tour-2024', title: NOISE_PARENT.title, category: 'tour', tourOf: NOISE_PARENT.id, openingDate: '2024-09-21', closingDate: '2026-07-12', status: 'closed', closingDateSource: 'tourstoyou', closingDateUpdatedAt: '2026-07-13' };
const NOISE_SHOWS = [NOISE_PARENT, NOISE_TOUR];

test('History tab labels: tour names with years, overseas companies and prose dropped', () => {
  const html = history(['2nd North American Tour (2026–', 'First North American Tour (2024&#8211;2026)', 'UK Tour (2023–2024)', 'Tour recoupment', 'The First National Tour was delayed', '2026-2027']);
  assert.deepEqual(tourHistoryLabels(html), [
    { name: '2nd North American Tour', from: 2026, to: null },
    { name: 'First North American Tour', from: 2024, to: 2026 },
  ]);
  // Name and years on separate lines.
  assert.deepEqual(tourHistoryLabels(history(['North American Tour', '2025–'])), [{ name: 'North American Tour', from: 2025, to: null }]);
  assert.deepEqual(tourHistoryLabels('<p>no history here</p>'), []);
});

test('isSeparateTour: New York run, a newer label, a closed label, one running label, silence', () => {
  const two = history(['2nd North American Tour (2026–', 'First North American Tour (2024–2026)']);
  assert.equal(isSeparateTour({ html: two, earlierLaunch: '2024-09-21', laterStart: '2026-10-30' }).separate, true);
  const closed = history(['First North American Tour (2024–2026)']);
  assert.equal(isSeparateTour({ html: closed, earlierLaunch: '2024-01-10', laterStart: '2027-01-12' }).separate, true);
  const one = history(['North American Tour (2024–']);
  assert.equal(isSeparateTour({ html: one, earlierLaunch: '2024-09-21', laterStart: '2026-10-30' }).separate, false);
  assert.equal(isSeparateTour({ html: '', earlierLaunch: '2024-09-21', laterStart: '2026-10-30' }).separate, null);
  assert.equal(isSeparateTour({ html: one, earlierLaunch: '2024-09-21', laterStart: '2026-10-30', afterNewYork: true }).separate, true);
});

test('splitSegmentsAt cuts a segment after a closing date', () => {
  const segs = segmentTourRows(parseTourSchedule(table(NOISE_ROWS)));
  assert.equal(segs.length, 1);
  const split = splitSegmentsAt(segs, ['2026-07-12']);
  assert.equal(split.length, 2);
  assert.equal(split[1].start.toISOString().slice(0, 10), '2026-10-30');
  assert.equal(split[0].rows.length + split[1].rows.length, NOISE_ROWS.length);
  assert.equal(splitSegmentsAt(segs, []), segs);
});

test('2a: a closed tour whose page resumes is a new tour, the same tour back, or left alone', () => {
  const segments = segmentTourRows(parseTourSchedule(table(NOISE_ROWS)));
  const newTour = lifecyclePlan({ segments, html: history(['2nd North American Tour (2026–', 'First North American Tour (2024–2026)']), tours: [NOISE_TOUR] });
  assert.deepEqual(newTour.cuts, ['2026-07-12']);
  assert.deepEqual(newTour.reopen, []);
  const back = lifecyclePlan({ segments, html: history(['North American Tour (2024–']), tours: [NOISE_TOUR] });
  assert.deepEqual(back.cuts, []);
  assert.equal(back.reopen.length, 1);
  assert.equal(back.reopen[0].id, NOISE_TOUR.id);
  assert.equal(back.reopen[0].resumes, '2026-10-30');
  const silent = lifecyclePlan({ segments, html: '', tours: [NOISE_TOUR] });
  assert.deepEqual(silent.cuts, []);
  assert.deepEqual(silent.reopen, []);
  assert.equal(silent.undecided.length, 1);
});

test('2a end to end: the second Beautiful Noise tour is found, dated and built as upcoming', () => {
  const html = table(NOISE_ROWS) + history(['2nd North American Tour (2026–', 'First North American Tour (2024–2026)']);
  const r = runningTourCandidate({ slug: 'a-beautiful-noise', scheduleUrl: 'https://tourstoyou.org/shows/a-beautiful-noise/', html, shows: NOISE_SHOWS, now: NOW });
  assert.equal(r.candidate.segmentStart, '2026-10-30');
  assert.deepEqual(r.candidate.splitAt, ['2026-07-12']);
  assert.equal(openTourCandidates([r.candidate], NOISE_SHOWS).length, 1);
  const d = decideTourDates({ id: null, title: NOISE_PARENT.title, openingDate: null, closingDate: null }, html, '', NOW, { segmentStart: '2026-10-30', freshLaunchDays: 30, upcomingDays: 270, cuts: r.candidate.splitAt });
  assert.equal(d.write.openingDate, '2026-10-30', JSON.stringify(d));
  const built = buildTourEntry({ parent: NOISE_PARENT, shows: NOISE_SHOWS, decision: d, roundupUrl: null, scheduleUrl: 'https://tourstoyou.org/shows/a-beautiful-noise/', now: NOW });
  assert.equal(built.entry.id, 'a-beautiful-noise-the-neil-diamond-musical-tour-2026');
  assert.equal(built.entry.status, 'upcoming');
  // Same tour back from a layoff: no new tour, the old one reopens.
  const same = runningTourCandidate({ slug: 'a-beautiful-noise', scheduleUrl: 'u', html: table(NOISE_ROWS) + history(['North American Tour (2024–']), shows: NOISE_SHOWS, now: NOW });
  assert.equal(same.lifecycle.reopen[0].id, NOISE_TOUR.id);
  assert.equal(same.candidate && same.candidate.splitAt, undefined);
});

test('reopenTour clears the closing and stamps why', () => {
  const t = { ...NOISE_TOUR };
  assert.equal(reopenTour(t, { closingDate: '2026-07-12', resumes: '2026-10-30', reason: 'one tour' }, '2026-10-05'), true);
  assert.equal(t.closingDate, null);
  assert.equal(t.status, 'open');
  assert.match(t.closingDateSource, /reopened 2026-10-05/);
  assert.equal(t.closingDateUpdatedAt, '2026-10-05');
  assert.match(t.statusSource, /reopened 2026-10-05/);
  assert.equal(reopenTour(t, {}, '2026-10-05'), false, 'already open');
  // An earlier hand note survives; a human-corrected closing is never cleared.
  const noted = { ...NOISE_TOUR, statusSource: 'closed per producer (hand note)' };
  assert.equal(reopenTour(noted, { closingDate: '2026-07-12', resumes: '2026-10-30', reason: 'one tour' }, '2026-10-05'), true);
  assert.match(noted.statusSource, /^closed per producer \(hand note\) \| reopened/);
  const guarded = { ...NOISE_TOUR, humanCorrectedClosingDate: true };
  assert.equal(reopenTour(guarded, { closingDate: '2026-07-12', resumes: '2026-10-30', reason: 'x' }, '2026-10-05', ), false);
  assert.equal(guarded.closingDate, NOISE_TOUR.closingDate);
});

test('distinctWorksOfTitle compares works of the same kind only', () => {
  const shows = [
    { id: 'frozen-2018', category: 'broadway', title: 'Frozen', type: 'musical', creativeTeam: [{ name: 'Jennifer Lee', role: 'Book' }] },
    { id: 'frozen-2004', category: 'broadway', title: 'Frozen', type: 'play', creativeTeam: [{ name: 'Bryony Lavery', role: 'Playwright' }] },
  ];
  assert.equal(distinctWorksOfTitle('Frozen', shows).length, 2);
  assert.equal(distinctWorksOfTitle('Frozen', shows, 'musical').length, 1);
});

test('enrich splits the page where an earlier tour of the title closed', () => {
  const next = { id: 'a-beautiful-noise-the-neil-diamond-musical-tour-2026', category: 'tour', title: NOISE_TOUR.title, openingDate: '2026-10-30', closingDate: null };
  const shows = [NOISE_TOUR, next];
  assert.deepEqual(earlierClosings(next, shows), ['2026-07-12']);
  assert.deepEqual(earlierClosings(NOISE_TOUR, shows), []);
  const html = table(NOISE_ROWS) + history(['2nd North American Tour (2026–', 'First North American Tour (2024–2026)']);
  const d = decideTourDates(next, html, '', NOW, { cuts: earlierClosings(next, shows) });
  assert.ok(!d.problem, JSON.stringify(d));
  assert.ok(d.segmentRows.every(r => r.start.toISOString().slice(0, 10) >= '2026-10-30'), 'only the new tour\'s rows');
});

test('reopenBlocker: a hand-checked closing or a later tour covering the dates stops a reopen', () => {
  const segments = segmentTourRows(parseTourSchedule(table(NOISE_ROWS)));
  const html = history(['North American Tour (2024–']);
  const hand = { ...NOISE_TOUR, closingDateSource: 'hand-verified (producer site)' };
  const p1 = lifecyclePlan({ segments, html, tours: [hand] });
  assert.deepEqual(p1.reopen, []);
  assert.match(p1.undecided[0].reason, /checked by hand/);
  const later = { id: 'a-beautiful-noise-tour-2026', category: 'tour', title: NOISE_TOUR.title, openingDate: '2026-10-30', closingDate: null };
  assert.equal(reopenBlocker(NOISE_TOUR, [NOISE_TOUR, later], '2026-10-30'), `${later.id} launched after it closed and covers 2026-10-30`);
  const p2 = lifecyclePlan({ segments, html, tours: [NOISE_TOUR, later] });
  assert.ok(!p2.reopen.some(x => x.id === NOISE_TOUR.id));
  // A later tour that already ended before the resumed dates doesn't block.
  assert.equal(reopenBlocker(NOISE_TOUR, [NOISE_TOUR, { ...later, closingDate: '2026-09-01' }], '2026-10-30'), null);
  assert.equal(reopenBlocker(NOISE_TOUR, [NOISE_TOUR], '2026-10-30'), null);
});

// Shucked-like: a running first tour, and a second booked after a long layoff.
const SHUCK_ROWS = [
  row('Pittsburgh, PA', 'Benedum', 'January 10-21, 2025'),
  row('Cleveland, OH', 'Connor', 'February 4-16, 2025'),
  row('Toledo, OH', 'Stranahan', 'May 6-11, 2025'),
  row('Omaha, NE', 'Orpheum', 'September 2-14, 2025'),
  row('Tulsa, OK', 'Tulsa PAC', 'February 3-8, 2026'),
  row('Fresno, CA', 'Saroyan', 'March 3-8, 2026'),
  row('Reno, NV', 'Pioneer', 'January 12-17, 2027'),
  row('Boise, ID', 'Morrison', 'January 19-24, 2027'),
  row('Spokane, WA', 'First Interstate', 'February 2-7, 2027'),
];
const SHUCK_PARENT = { id: 'shucked-2023', title: 'Shucked', category: 'broadway', type: 'musical', openingDate: '2023-04-04', images: {} };
const SHUCK_TOUR = { id: 'shucked-tour-2025', title: 'Shucked', category: 'tour', tourOf: SHUCK_PARENT.id, openingDate: '2025-01-10', closingDate: null, status: 'open' };
const SHUCK_SHOWS = [SHUCK_PARENT, SHUCK_TOUR];
const SHUCK_HTML = table(SHUCK_ROWS) + history(['Second North American Tour (2027–', 'First North American Tour (2025–2026)']);

test('2b: a tour booked after a running tour\'s layoff is created before the first is marked closed', () => {
  const r = runningTourCandidate({ slug: 'shucked', scheduleUrl: 'https://tourstoyou.org/shows/shucked/', html: SHUCK_HTML, shows: SHUCK_SHOWS, now: NOW });
  assert.equal(r.candidate.segmentStart, '2027-01-12');
  assert.deepEqual(r.candidate.predecessorEnds, { 'shucked-tour-2025': '2026-03-08' });
  // Without the page's word, the running tour still owns the title.
  assert.equal(tourCandidateFor('national-tour', SHUCK_PARENT, SHUCK_SHOWS), null);
  assert.equal(openTourCandidates([r.candidate], SHUCK_SHOWS).length, 1);
  const d = decideTourDates({ id: null, title: 'Shucked', openingDate: null, closingDate: null }, SHUCK_HTML, '', NOW, { segmentStart: '2027-01-12', freshLaunchDays: 30, upcomingDays: 270 });
  assert.equal(d.write.openingDate, '2027-01-12', JSON.stringify(d));
  assert.match(buildTourEntry({ parent: SHUCK_PARENT, shows: SHUCK_SHOWS, decision: d, scheduleUrl: 'https://tourstoyou.org/shows/shucked/', now: NOW }).skip, /still open/);
  const built = buildTourEntry({ parent: SHUCK_PARENT, shows: SHUCK_SHOWS, decision: d, scheduleUrl: 'https://tourstoyou.org/shows/shucked/', knownEnds: r.candidate.predecessorEnds, now: NOW });
  assert.equal(built.entry.id, 'shucked-tour-2027');
  assert.equal(built.entry.status, 'upcoming');
  // A page that doesn't say the later block is a new tour leaves it alone.
  const quiet = runningTourCandidate({ slug: 'shucked', scheduleUrl: 'u', html: table(SHUCK_ROWS), shows: SHUCK_SHOWS, now: NOW });
  assert.equal(quiet.candidate, undefined);
  assert.match(quiet.skip, /already tracked as shucked-tour-2025/);
});

test('a re-recorded row drops page facts an earlier run recorded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-lifecycle-'));
  const file = path.join(dir, 'c.json');
  const base = { broadwayShowId: 'shucked-2023', title: 'Shucked', source: 'tourstoyou', slug: 'tourstoyou:shucked:2027-01-12', segmentStart: '2027-01-12' };
  recordTourCandidates(file, [{ ...base, predecessorEnds: { 'shucked-tour-2025': '2026-03-08' } }]);
  recordTourCandidates(file, [base]);
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rows[0].predecessorEnds, undefined);
});

test('2c: a page carrying another tour\'s table is blocked, and the corrected page is picked up', () => {
  const MINCE = table([
    row('Chicago, IL', 'CIBC', 'September 20-October 4, 2026'),
    row('Detroit, MI', 'Fisher', 'October 6-18, 2026'),
    row('Boston, MA', 'Emerson', 'October 20-November 1, 2026'),
  ]);
  const parent = { id: 'come-from-away-2017', title: 'Come From Away', category: 'broadway', type: 'musical', openingDate: '2017-03-12', images: {} };
  const shows = [parent];
  const schedules = { 'operation-mincemeat-tour-2026': { stops: parseTourSchedule(MINCE).map(r => ({ city: r.city, venue: r.venue, start: r.start.toISOString().slice(0, 10), end: r.end.toISOString().slice(0, 10) })) } };
  const wrong = runningTourCandidate({ slug: 'come-from-away', scheduleUrl: 'u', html: MINCE, shows, now: NOW });
  const dWrong = decideTourDates({ id: null, title: parent.title, openingDate: null, closingDate: null }, MINCE, '', NOW, { segmentStart: wrong.candidate.segmentStart, freshLaunchDays: 30, upcomingDays: 270 });
  assert.equal(duplicateScheduleOf(dWrong.segmentRows, schedules), 'operation-mincemeat-tour-2026');
  // The row stays open (nothing was created), so it is retried every run.
  assert.equal(openTourCandidates([wrong.candidate], shows).length, 1);
  const RIGHT = table([
    row('Hartford, CT', 'Bushnell', 'November 3-8, 2026'),
    row('Providence, RI', 'PPAC', 'November 10-15, 2026'),
    row('Albany, NY', 'Proctors', 'November 17-22, 2026'),
  ]);
  const right = runningTourCandidate({ slug: 'come-from-away', scheduleUrl: 'u', html: RIGHT, shows, now: NOW });
  assert.equal(right.candidate.segmentStart, '2026-11-03');
  assert.notEqual(right.candidate.slug, wrong.candidate.slug, 'a fresh candidate row, not the blocked one');
  const dRight = decideTourDates({ id: null, title: parent.title, openingDate: null, closingDate: null }, RIGHT, '', NOW, { segmentStart: '2026-11-03', freshLaunchDays: 30, upcomingDays: 270 });
  assert.equal(duplicateScheduleOf(dRight.segmentRows, schedules), null);
});

test('a title naming two different Broadway works never gets a tour by title alone', () => {
  const shows = [
    { id: 'a-christmas-carol-2019', title: 'A Christmas Carol', category: 'broadway', openingDate: '2019-11-20', creativeTeam: [{ role: 'Playwright', name: 'Jack Thorne' }] },
    { id: 'a-christmas-carol-1991', title: 'A Christmas Carol', category: 'broadway', openingDate: '1991-12-19', creativeTeam: [{ role: 'Adapted by', name: 'Patrick Stewart' }] },
    { id: 'a-christmas-carol-2022', title: 'A Christmas Carol', category: 'broadway', openingDate: '2022-11-21', creativeTeam: [{ role: 'Adapted by', name: 'Patrick Stewart, Michael Arden' }] },
  ];
  assert.deepEqual(distinctWorksOfTitle('A Christmas Carol', shows), [['a-christmas-carol-2019'], ['a-christmas-carol-1991', 'a-christmas-carol-2022']]);
  const d = { write: { openingDate: '2026-11-28' }, notes: [], launchSource: 'tourstoyou-upcoming' };
  assert.match(buildTourEntry({ parent: shows[2], shows, decision: d, scheduleUrl: 'https://tourstoyou.org/shows/a-christmas-carol-1/', now: NOW }).skip, /different Broadway works/);
  // One work (revivals by the same writers) is fine.
  assert.equal(distinctWorksOfTitle('A Christmas Carol', shows.slice(1)).length, 1);
});

test('task 3: a tour opening skips the opening-night pipeline', () => {
  const shows = [{ id: 'hit-2026', category: 'broadway' }, { id: 'hit-tour-2026', category: 'tour' }, { id: 'old-2020', category: 'broadway' }];
  const updates = [
    { id: 'hit-2026', changes: { status: { from: 'previews', to: 'open' } } },
    { id: 'hit-tour-2026', changes: { status: { from: 'upcoming', to: 'open' } } },
    { id: 'old-2020', changes: { status: { from: 'previews', to: 'open' }, reviewDriven: true } },
    { id: 'gone', changes: { status: { from: 'previews', to: 'open' } } },
  ];
  const { opened, openedTours } = splitOpenedShows(updates, shows);
  assert.deepEqual(opened.map(u => u.id), ['hit-2026', 'gone']);
  assert.deepEqual(openedTours.map(u => u.id), ['hit-tour-2026']);
  const now = new Date('2026-10-06T12:00:00Z');
  assert.equal(isOpeningNightTarget({ category: 'tour', openingDate: '2026-10-06' }, now), false);
  assert.equal(isOpeningNightTarget({ category: 'broadway', openingDate: '2026-10-06' }, now), true);
  assert.equal(isOpeningNightTarget({ openingDate: '2026-10-20' }, now), false);
});
