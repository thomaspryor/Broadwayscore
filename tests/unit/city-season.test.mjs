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

test('findExisting: matches by title, uses the venue to split same-title shows', () => {
  const shows = [{ id: 'a', title: 'Cabaret', venue: 'New Village Arts, Carlsbad, CA' }, { id: 'b', title: 'Cabaret', venue: 'Cygnet Theatre, San Diego, CA' }];
  assert.equal(S.findExisting({ title: 'Cabaret', theatre: 'Cygnet Theatre' }, shows).id, 'b');
  assert.equal(S.findExisting({ title: 'Other', theatre: 'Cygnet Theatre' }, shows), null);
});

test('pageToText keeps each link next to its label', () => {
  const o = pageToText('<a href="/x">Arrowhead</a> Nov 12', 'https://a.org/s');
  assert.equal(o.text, 'Arrowhead (https://a.org/x) Nov 12');
  assert.deepEqual(o.links, ['https://a.org/x']);
});
