import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isShowScoreStatusEligible } = require('./showscore-status-eligibility.js');
const { checkTourData, checkShowPage, expectedCities, isScoredSlim } = require('./tour-page-audit.js');
import { readFileSync } from 'node:fs';

// BRO-4876: ShowScore "Closed" on a tour's borrowed URL closed the live
// Operation Mincemeat tour with no closingDate; the audit then saw 24 future stops.
const urls = { 'operation-mincemeat-tour-2026': 'x', 'a-show': 'y' };

test('ShowScore refresh never touches tours', () => {
  assert.equal(isShowScoreStatusEligible({ id: 'operation-mincemeat-tour-2026', category: 'tour', status: 'open' }, urls), false);
});
test('ShowScore refresh still covers open non-tour shows with a URL', () => {
  assert.equal(isShowScoreStatusEligible({ id: 'a-show', category: 'broadway', status: 'open' }, urls), true);
  assert.equal(isShowScoreStatusEligible({ id: 'a-show', category: 'off-broadway', status: 'previews' }, urls), true);
  assert.equal(isShowScoreStatusEligible({ id: 'a-show', category: 'broadway', status: 'closed' }, urls), false);
  assert.equal(isShowScoreStatusEligible({ id: 'nope', category: 'broadway', status: 'open' }, urls), false);
});
test('audit flags a closed tour that still has future stops', () => {
  const show = { id: 't', title: 'T', category: 'tour', status: 'closed', closingDate: null, openingDate: '2026-09-20', images: { poster: '/images/shows/t/poster.webp' }, synopsis: 'x'.repeat(50) };
  const schedule = { stops: [{ city: 'Boston, MA', venue: 'V', start: '2026-12-01', end: '2026-12-06' }] };
  const out = checkTourData({ show, parent: null, schedule, today: '2026-10-08' });
  assert.ok(out.some(f => f.code === 'closed-tour-has-future-stops'));
});

test('Show Score URL discovery skips tours (they only find the parent page)', () => {
  const { canDiscoverShowScoreUrl } = require('./showscore-status-eligibility.js');
  assert.equal(canDiscoverShowScoreUrl({ category: 'tour' }), false);
  assert.equal(canDiscoverShowScoreUrl({ category: 'broadway' }), true);
});

// BRO-4978: the schedule fetcher must keep exactly what the audit accepts.
test('fetcher drops stops ending before openingDate but keeps an opening engagement that starts early', () => {
  const { rowsFromLaunch } = require('../fetch-tour-schedules.js');
  const d = s => new Date(`${s}T00:00:00Z`);
  const row = (city, start, end) => ({ city, venue: 'V', start: d(start), end: d(end) });
  const show = { id: 'dd', title: 'Dirty Dancing', category: 'tour', status: 'open', closingDate: null, openingDate: '2026-08-12', images: { poster: '/images/shows/dd/poster.webp' }, synopsis: 'x'.repeat(50) };
  const rows = [row('Utica, NY', '2026-08-07', '2026-08-07'), row('Wichita, KS', '2026-08-10', '2026-08-23'), row('St. Paul, MN', '2026-08-25', '2026-09-06')];
  const kept = rowsFromLaunch(rows, show);
  assert.deepEqual(kept.map(r => r.city), ['Wichita, KS', 'St. Paul, MN']);
  const iso = x => x.toISOString().slice(0, 10);
  const stops = kept.map(r => ({ city: r.city, venue: r.venue, start: iso(r.start), end: iso(r.end) }));
  assert.ok(!checkTourData({ show, parent: null, schedule: { stops }, today: '2026-10-11' }).some(f => f.code === 'stops-before-opening'));
  const all = rows.map(r => ({ city: r.city, venue: r.venue, start: iso(r.start), end: iso(r.end) }));
  assert.ok(checkTourData({ show, parent: null, schedule: { stops: all }, today: '2026-10-11' }).some(f => f.code === 'stops-before-opening'));
});

// BRO-4979: city pages count scored tours only, but the tours list also carries
// unscored running tours, so the audit expected 31 pages the site never builds.
test('expectedCities counts only the scored ids it is given', () => {
  const stop = { city: 'Ames, IA', start: '2026-11-01', end: '2026-11-02' };
  const tours = ['a', 'b', 'c', 'd'].map(id => ({ id, status: 'open' }));
  const schedules = Object.fromEntries(tours.map(t => [t.id, { stops: [stop] }]));
  const cities = ids => expectedCities({ tours, schedules, listedIds: new Set(ids), today: '2026-10-12' });
  assert.ok(cities(['a', 'b', 'c']).has('ames-ia'));
  assert.ok(!cities(['a', 'b']).has('ames-ia'), 'two scored + two unscored tours must not make a page');
});

test('audit script feeds expectedCities scored ids, not every tours-list id', () => {
  const src = readFileSync(new URL('../audit-tour-pages.js', import.meta.url), 'utf8');
  assert.ok(!/expectedCities\([^)]*listedIds: new Set\(listed\.keys\(\)\)/.test(src));
  assert.ok(/listedIds: scoredIds/.test(src));
});

test('isScoredSlim: cs present means scored; missing json or cs does not', () => {
  assert.equal(isScoredSlim({ cs: 84.59 }), true);
  assert.equal(isScoredSlim({ id: 'x', cov: {} }), false);
  assert.equal(isScoredSlim(null), false);
});

// BRO-4981: an unscored tour card has no "N reviews" line; the list parser
// used to climb into the grid and borrow the neighbouring card's count.
test('parseListPage: unscored tour card does not borrow a neighbour review count', () => {
  const { parseListPage } = require('./tour-page-audit.js');
  const card = (id, rc) => `<div><a href="/show/${id}"><div>${id}</div>${rc ? `<span>${rc}</span>` : ''}</a></div>`;
  const html = `<html><body><div>${card('a-tour-2026', '3 reviews')}${card('b-tour-2026', null)}${card('c-tour-2026', '5 reviews')}</div></body></html>`;
  const byId = Object.fromEntries(parseListPage(html).shows.map(s => [s.id, s.reviewCount]));
  assert.deepEqual(byId, { 'a-tour-2026': 3, 'b-tour-2026': null, 'c-tour-2026': 5 });
});

// BRO-4980: 273 schedule-city-unlinked errors came from expectedCities counting
// unscored tours (BRO-4979). With the scored-only set, a city the site never
// builds must not be demanded as a link, and a real city page still must be.
test('schedule-city-unlinked follows the scored-only city set', () => {
  const stop = { city: 'Ames, IA', venue: 'V', start: '2026-11-01', end: '2026-11-02' };
  const tours = ['a', 'b', 'c', 'd'].map(id => ({ id, status: 'open' }));
  const schedules = Object.fromEntries(tours.map(t => [t.id, { stops: [stop] }]));
  const cityPages = ids => new Set(expectedCities({ tours, schedules, listedIds: new Set(ids), today: '2026-10-12' }).keys());
  const page = cityHref => ({
    tourSubtitle: 'National Tour', now: null, next: null, hasSchedule: true, scheduleCount: 1,
    scheduleAll: [{ city: stop.city, venue: stop.venue, range: '', cityHref }], scheduleShown: [], ticketHrefs: [], jsonLd: [], rows: [], h: [],
  });
  const run = (cp, href) => checkShowPage({ url: '/show/a', page: page(href), show: { id: 'a', status: 'open' }, schedule: { stops: [stop] }, todays: ['2026-10-12'], cityPages: cp })
    .filter(f => /^schedule-city-/.test(f.code)).map(f => f.code);
  assert.deepEqual(run(cityPages(['a', 'b']), null), [], 'unscored mix builds no Ames page, so no link is expected');
  assert.deepEqual(run(cityPages(['a', 'b', 'c']), null), ['schedule-city-unlinked']);
  assert.deepEqual(run(cityPages(['a', 'b', 'c']), '/tours/ames-ia'), []);
});
