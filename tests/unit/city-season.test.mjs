import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../../scripts/lib/city-season.js');
const { getFinder } = require('../../scripts/lib/city-finder-config.js');
const { pageToText } = require('../../scripts/lib/season-page-reader.js');

const sd = getFinder('san-diego');
const TODAY = '2026-11-09';
const theatre = sd.theatres.find((t) => /North Coast/.test(t.name));

test('window: needs real ISO dates, current or within ~3 months, no season banners', () => {
  const ok = { start: '2026-11-01', end: '2026-12-01' };
  assert.ok(S.usableWindow(ok, TODAY));
  assert.ok(!S.usableWindow({ start: '2026-01-01', end: '2026-02-01' }, TODAY), 'already closed');
  assert.ok(!S.usableWindow({ start: '2027-06-01', end: '2027-07-01' }, TODAY), 'beyond horizon');
  assert.ok(!S.usableWindow({ start: '2026-09-01', end: '2027-09-01' }, TODAY), 'season banner');
  assert.ok(!S.usableWindow({ start: null, end: '2026-12-01' }, TODAY), 'no start');
  assert.ok(!S.usableWindow({ start: '2026-12-05', end: '2026-12-01' }, TODAY), 'inverted');
});

test('page rows: every row must be backed by the page text', () => {
  const pageText = 'North Coast Rep presents The Cottage Oct 28 to Dec 6 (https://x.org/cottage)';
  const rows = [
    { title: 'The Cottage', start: '2026-10-28', end: '2026-12-06', type: 'play', url: 'https://x.org/cottage' },
    { title: 'Invented Show', start: '2026-10-28', end: '2026-12-06', url: null },
    { title: 'The Cottage', start: '2026-03-01', end: '2026-04-01', url: null },
    { title: 'Holiday Concert', start: '2026-11-20', end: '2026-11-21', url: null },
  ];
  const out = S.fromPageRows(rows, { theatre, pageText, pageLinks: ['https://x.org/cottage'], pageUrl: 'https://x.org/', today: TODAY });
  assert.deepEqual(out.map((r) => r.title), ['The Cottage']);
  assert.equal(out[0].pageUrl, 'https://x.org/cottage');
  assert.equal(out[0].source, 'theatre-season-page');
});

test('BWW rows: allowlisted professional theatres only, non-productions dropped', () => {
  const rows = [
    { title: 'Arrowhead', theatre: 'Diversionary Theatre', city: 'San Diego', start: '2026-11-12', end: '2026-12-06', bwwUrl: 'https://www.broadwayworld.com/san-diego/regional/a', image: 'i.jpg' },
    { title: 'Some Show', theatre: 'Random Community Players', city: 'San Diego', start: '2026-11-12', end: '2026-12-06' },
    { title: 'Holiday Tour', theatre: 'Diversionary Theatre', city: 'San Diego', start: '2026-11-12', end: '2026-12-06' },
  ];
  const out = S.fromBwwRows(rows, sd, TODAY);
  assert.deepEqual(out.map((r) => r.title), ['Arrowhead']);
});

test('merge: theatre-page dates win, listing art is kept; duplicate titles collapse', () => {
  const a = { title: 'Arrowhead', theatre: 'Diversionary Theatre', start: '2026-11-12', end: '2026-12-05', source: 'broadwayworld-regional-listing', pageUrl: 'https://www.broadwayworld.com/x', image: 'i.jpg' };
  const b = { title: 'Arrowhead', theatre: 'Diversionary Theatre', start: '2026-11-12', end: '2026-12-06', source: 'theatre-season-page', pageUrl: 'https://div.org/a', image: null };
  const [m] = S.mergeSeason([[a], [b]]);
  assert.equal(S.mergeSeason([[a], [b]]).length, 1);
  assert.equal(m.end, '2026-12-06');
  assert.equal(m.image, 'i.jpg');
  assert.match(m.bwwUrl, /broadwayworld/);
});

test('buildShow: sourced dates, upcoming vs open, regional id', () => {
  const hub = { discoverySource: 'city-hub:san-diego' };
  const row = { title: 'Cabaret', theatre: 'New Village Arts', city: 'Carlsbad', start: '2027-01-29', end: '2027-03-14', source: 'theatre-season-page', pageUrl: 'https://n.org/c' };
  const id = S.showId(row, new Set());
  assert.equal(id, 'cabaret-regional-2027');
  assert.equal(S.showId(row, new Set([id])), 'cabaret-new-regional-2027');
  const show = S.buildShow(row, { id, hubSlug: 'san-diego-ca', hub, city: sd, today: TODAY });
  assert.equal(show.status, 'upcoming');
  assert.equal(show.closingDate, '2027-03-14');
  assert.equal(show.closingDateSource, 'theatre-season-page');
  assert.equal(show.type, 'musical');
  assert.equal(S.buildShow({ ...row, start: '2026-11-01' }, { id, hubSlug: 'san-diego-ca', hub, city: sd, today: TODAY }).status, 'open');
});

test('findExisting: same title + overlapping year + theatre; a new year of an annual show is new', () => {
  const shows = [
    { id: 'a', title: 'Cabaret', venue: 'New Village Arts, Carlsbad, CA', openingDate: '2027-01-29', closingDate: '2027-03-14' },
    { id: 'b', title: 'Cabaret', venue: 'Cygnet Theatre, San Diego, CA', openingDate: '2027-01-29', closingDate: '2027-03-14' },
    { id: 'c', title: 'A Christmas Carol', venue: 'Cygnet Theatre, San Diego, CA', openingDate: '2025-12-01', closingDate: '2025-12-24' },
  ];
  assert.equal(S.findExisting({ title: 'Cabaret', theatre: 'Cygnet Theatre', start: '2027-02-01', end: '2027-03-01' }, shows).id, 'b');
  assert.equal(S.findExisting({ title: 'Cabaret', theatre: 'Moxie Theatre', start: '2027-02-01', end: '2027-03-01' }, shows), null, 'other theatre');
  assert.equal(S.findExisting({ title: 'A Christmas Carol', theatre: 'Cygnet Theatre', start: '2026-12-01', end: '2026-12-24' }, shows), null, 'new year');
});

test('resolveTheatre: a generic or student/rental venue never maps to a producing theatre', () => {
  const bos = getFinder('boston');
  for (const v of ['Boston', 'Stage', 'Farkas Hall', 'Boston Center for the Arts', 'Emerson Colonial Theatre', 'ArtsEmerson']) assert.equal(S.resolveTheatre(bos, v), null, v);
  assert.equal(S.resolveTheatre(bos, 'Lyric Stage Company of Boston').name, 'Lyric Stage Company of Boston');
});

test('page rows: a word that merely starts like a month is not a date', () => {
  const pageText = 'The Cottage closed last spring. Janet says hi.';
  const rows = [{ title: 'The Cottage', start: '2027-01-05', end: '2027-02-01' }];
  assert.equal(S.fromPageRows(rows, { theatre, pageText, pageUrl: 'https://x.org/', today: '2026-11-09' }).length, 0);
});

test('pageToText keeps each link next to its label', () => {
  const o = pageToText('<a href="/x">Arrowhead</a> Nov 12', 'https://a.org/s');
  assert.equal(o.text, 'Arrowhead (https://a.org/x) Nov 12');
  assert.deepEqual(o.links, ['https://a.org/x']);
});

test('pendingShows: only live plans lock their shows out', async () => {
  const S = require('../../scripts/lib/city-season');
  const mk = (status, id) => ({ status, plan: { actions: [{ type: 'add-show', show: { id } }] } });
  const got = S.pendingShows([mk('pending', 'a'), mk('applied', 'b'), mk('validation-failed', 'c'), mk('rejected', 'd'), mk('superseded', 'e'), null]);
  assert.deepEqual(got.map((x) => x.id), ['a', 'b']);
});

// BRO-7291 class 6: GRIM (La Jolla Playhouse) came out of the season page as 2026-11-27..12-13; its own page says
// "Extended! Oct 27 – Dec 13" with First Look previews Oct 27 - Nov 1 mat. The BRO-7257 hand fix set opening 2026-11-01.
// Fixture: the two header lines of https://lajollaplayhouse.org/show/grim/ (fetched 2026-11-10), nav link kept.
const GRIM_PAGE = 'Season (https://lajollaplayhouse.org/events) Extended! Oct 27 – Dec 13 | Mandell Weiss Theatre Book by ... '
  + 'ticket seller for this production. First Look (previews)*: Oct 27 - Nov 1 mat Weeks 2 – 7: Nov 1 eve - Dec 13';
const GRIM_ROW = { title: 'GRIM', theatre: 'La Jolla Playhouse', city: 'La Jolla', start: '2026-11-27', end: '2026-12-13', source: 'theatre-season-page', pageUrl: 'https://lajollaplayhouse.org/show/grim/', image: null };

test('class 6 replay: GRIM production page run beats the season page (opening = end of previews)', () => {
  const r = S.runRangeFromShowPage(GRIM_PAGE, { year: 2026 });
  assert.deepEqual([r.first, r.opening, r.end], ['2026-10-27', '2026-11-01', '2026-12-13']);
  const { row, held } = S.settleRunDates(GRIM_ROW, r, GRIM_ROW.pageUrl);
  assert.equal(held, null);
  assert.deepEqual([row.start, row.end, row.source], ['2026-11-01', '2026-12-13', 'theatre-show-page']);
  const show = S.buildShow(row, { id: 'grim-regional-2026', hubSlug: 'san-diego-ca', hub: { discoverySource: 'x' }, city: { defaultCity: 'La Jolla', state: 'CA' }, today: '2026-11-09' });
  assert.equal(show.openingDate, '2026-11-01');
  assert.match(show.openingDateSource, /production page "/);
});

test('class 6: listing and season page disagreeing >3 days with no run on the production page -> held', () => {
  const bww = { ...GRIM_ROW, start: '2026-10-27', source: 'broadwayworld-regional-listing', pageUrl: 'https://www.broadwayworld.com/san-diego/regional/GRIM' };
  const [m] = S.mergeSeason([[bww], [GRIM_ROW]]);
  assert.ok(m.dateConflict, 'conflict recorded');
  const { held } = S.settleRunDates(m, null, null);
  assert.match(held, /disagree/);
  // agreeing sources are not held
  const [ok] = S.mergeSeason([[{ ...bww, start: '2026-11-26' }], [GRIM_ROW]]);
  assert.equal(S.settleRunDates(ok, null, null).held, null);
});

test('class 6: run ranges across the new year, explicit years, opening-night lines; other productions ignored', () => {
  assert.deepEqual(S.runRangeFromShowPage('Now playing Jan 5 – Feb 9, 2027', { year: 2026 }).first, '2027-01-05');
  assert.equal(S.runRangeFromShowPage('Dec 1 - Jan 4', { year: 2026 }).end, '2027-01-04');
  assert.equal(S.runRangeFromShowPage('Performances Sept. 12 through Oct. 19. Opening night: Sept. 20', { year: 2026 }).opening, '2026-09-20');
  assert.equal(S.runRangeFromShowPage('Saturday Nov 8 7pm - 9pm', { year: 2026 }), null);
  // a sidebar range that does not overlap the row is another show's: ignored
  const other = S.runRangeFromShowPage('Also playing: Mar 3 - Apr 12', { year: 2027 });
  assert.equal(S.settleRunDates(GRIM_ROW, other, 'u').row.start, '2026-11-27');
});

test('class 6: opening comes from the page\'s own opening line, else the day after the last preview (real pages 2026-11-10)', () => {
  const cases = [
    ['As You Like It | October 16-November 29 PREVIEWS October 16-23, 2026 OPENING October 24, 2026', '2026-10-16', '2026-10-24'], // newvillagearts.org
    ['Nov 12 – Dec 6, 2026 Opening Night: November 21, 2026 Previews : Nov 12 – 20', '2026-11-12', '2026-11-21'], // diversionary.org
    ['Mexodus Dec 4 - Jan 10, 2027 see showtimes Opening Night Thursday December 10 7:30PM', '2026-12-04', '2026-12-10'], // americanrepertorytheater.org
    ['Nov 12 – Dec 6 Previews: Nov 12 – 20', '2026-11-12', '2026-11-21'],
  ];
  for (const [t, first, opening] of cases) {
    const r = S.runRangeFromShowPage(t, { year: 2026 });
    assert.deepEqual([r.first, r.opening], [first, opening], t);
  }
});
