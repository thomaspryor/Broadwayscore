// Unit tests for scripts/lib/alltime-attribution.js (BRO-5012): an all-time
// row copied onto several productions stays only on the one whose run fits.
// Fixtures are the real shows.json run dates of the 2026-10-10 groups.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sharedAllTimeClears, misplacedAllTimeMoves, applyAllTimeAttribution, runCapacity } = require('../../scripts/lib/alltime-attribution.js');

const NOW = new Date('2026-10-10T00:00:00Z');
const at = (gross, performances, attendance = 1) => ({ allTime: { gross, performances, attendance } });
const bw = (slug, p, c, extra = {}) => ({ id: slug, slug, category: 'broadway', market: 'broadway', previewsStartDate: p, closingDate: c, ...extra });
const MAMMA = [bw('mamma-mia-2001', '2001-10-05', '2015-09-12'), bw('mamma-mia', '2025-08-02', '2026-02-01', { id: 'mamma-mia-2025' })];

test('Mamma Mia!: the 2001 run keeps the 5,979-performance row, the 2025 return is cleared', () => {
  const g = { 'mamma-mia': at(670_150_538, 5979), 'mamma-mia-2001': at(670_150_538, 5979) };
  const c = sharedAllTimeClears(g, MAMMA, { now: NOW });
  assert.deepEqual(c.map((x) => [x.slug, x.owner]), [['mamma-mia', 'mamma-mia-2001']]);
  assert.match(c[0].reason, /cannot hold 5979/);
});

test('when both runs could hold the count, the closer run length wins (Frozen 2018, not a 2004 play)', () => {
  const shows = [bw('frozen-2004', '2004-04-28', '2004-08-22'), bw('frozen-2018', '2018-02-22', '2020-03-11')];
  const g = { 'frozen-2004': at(155_193_554, 848), 'frozen-2018': at(155_193_554, 848) };
  assert.deepEqual(sharedAllTimeClears(g, shows, { now: NOW }).map((x) => x.slug), ['frozen-2004']);
  // Two revivals that both fit: the one whose capacity is nearest the count owns it.
  const two = [bw('a-1973', '1973-12-26', '1974-11-17'), bw('a-2007', '2007-03-09', '2007-06-10')];
  const g2 = { 'a-1973': at(5, 84), 'a-2007': at(5, 84) };
  assert.deepEqual(sharedAllTimeClears(g2, two, { now: NOW }).map((x) => [x.slug, x.owner]), [['a-1973', 'a-2007']]);
});

test('Off-Broadway and West End copies never own, even when their run fits; category is the tier, not market', () => {
  const shows = [
    bw('little-shop-of-horrors-2003', '2003-08-01', '2003-08-24'),
    bw('little-shop-of-horrors-off-broadway', '2019-09-17', null, { category: 'off-broadway' }),
    bw('the-phantom-of-the-opera-west-end', '1986-09-27', null, { category: 'west-end', market: 'west-end' }),
    bw('the-phantom-of-the-opera-1988', '1988-01-09', '2023-04-16'),
  ];
  const g = {
    'little-shop-of-horrors-2003': at(1, 412), 'little-shop-of-horrors-off-broadway': at(1, 412),
    'the-phantom-of-the-opera-west-end': at(2, 13_995), 'the-phantom-of-the-opera-1988': at(2, 13_995),
  };
  const c = sharedAllTimeClears(g, shows, { now: NOW });
  assert.deepEqual(c.map((x) => x.slug), ['little-shop-of-horrors-off-broadway', 'the-phantom-of-the-opera-west-end']);
});

test('a total summed over several revivals fits no run: Broadway copies stay, non-Broadway copies go', () => {
  const shows = [
    bw('beetlejuice-2019', '2019-03-28', '2020-03-10'), bw('beetlejuice-2022', '2022-04-08', '2023-01-08'),
    bw('beetlejuice-west-end', '2026-05-20', '2027-01-02', { category: 'west-end', market: 'west-end' }),
  ];
  const g = { 'beetlejuice-2019': at(3, 806), 'beetlejuice-2022': at(3, 806), 'beetlejuice-west-end': at(3, 806) };
  const c = sharedAllTimeClears(g, shows, { now: NOW });
  assert.deepEqual(c.map((x) => [x.slug, x.owner]), [['beetlejuice-west-end', null]]);
});

test('unique rows, rows without a gross, slugs missing from shows.json and shows without dates are left alone', () => {
  const shows = [...MAMMA, bw('nodates', null, null), bw('nodates-2', null, null)];
  const g = {
    'mamma-mia-2001': at(670_150_538, 5979), 'mamma-mia': at(1, 10),
    'not-in-shows': at(670_150_538, 5979),
    nodates: at(9, 100), 'nodates-2': at(9, 100),
    empty: { allTime: { gross: null, performances: null, attendance: null } },
  };
  assert.deepEqual(sharedAllTimeClears(g, shows, { now: NOW }), []);
  assert.equal(runCapacity({ previewsStartDate: null, openingDate: null }, NOW.getTime()), null);
});

test('Chicago: a fresh row on the 1975 original (2-year run, 11,711 shows) moves to the running 1996 revival', () => {
  const shows = [
    { id: 'chicago-1975', slug: 'chicago-1975', title: 'Chicago', category: 'broadway', previewsStartDate: '1975-05-12', closingDate: '1977-08-27' },
    { id: 'chicago-1996', slug: 'chicago', title: 'Chicago', category: 'broadway', previewsStartDate: '1996-10-23', closingDate: null },
    { id: 'chicago-west-end-1997', slug: 'chicago-west-end-1997', title: 'Chicago', category: 'west-end', previewsStartDate: '1997-11-18', closingDate: null },
  ];
  const g = { 'chicago-1975': at(858_751_483, 11_711, 11_203_661), chicago: at(841_293_397, 11_558, 11_074_024) };
  assert.deepEqual(misplacedAllTimeMoves(g, shows, { now: NOW }).map((m) => [m.slug, m.to]), [['chicago-1975', 'chicago']]);
  const r = applyAllTimeAttribution(g, shows, { now: NOW });
  assert.equal(r.moves.length, 1);
  assert.deepEqual(g.chicago.allTime, { gross: 858_751_483, performances: 11_711, attendance: 11_203_661 });
  assert.deepEqual(g['chicago-1975'].allTime, { gross: null, performances: null, attendance: null });
});

test('a move takes one whole row, never fields mixed from two scrapes; no previews date means four weeks before opening', () => {
  const shows = [
    { id: 'y-1975', slug: 'y-1975', title: 'Y', category: 'broadway', previewsStartDate: '1975-05-12', closingDate: '1977-08-27' },
    { id: 'y-1996', slug: 'y', title: 'Y', category: 'broadway', previewsStartDate: '1996-10-23', closingDate: null },
  ];
  const g = { 'y-1975': at(800, 11_711, 10), y: at(900, 11_000, 20) };
  applyAllTimeAttribution(g, shows, { now: NOW });
  assert.deepEqual(g.y.allTime, { gross: 900, performances: 11_000, attendance: 20 });
  const opensOnly = { previewsStartDate: null, openingDate: '2020-01-29', closingDate: '2020-01-29' };
  assert.equal(runCapacity(opensOnly, NOW.getTime()), 5 * 8);
});

test('an impossible count with no same-title run that fits is not moved but cleared; an undated or open-ended sibling is not a fit', () => {
  const shows = [
    { id: 'x-2024', slug: 'x-2024', title: 'X', category: 'broadway', previewsStartDate: '2024-03-01', closingDate: '2024-04-01' },
    { id: 'x-1970', slug: 'x-1970', title: 'X', category: 'broadway', previewsStartDate: '1970-01-01', closingDate: null },
    { id: 'x-1990', slug: 'x-1990', title: 'X', category: 'broadway' },
  ];
  const g = { 'x-2024': at(1, 500) };
  assert.deepEqual(misplacedAllTimeMoves(g, shows, { now: NOW }), []);
  const r = applyAllTimeAttribution(g, shows, { now: NOW });
  assert.deepEqual(r.clears.map((c) => c.slug), ['x-2024']);
  assert.equal(g['x-2024'].allTime.gross, null);
});

test('BRO-5016 Beetlejuice: a total over three runs that none could play alone is cleared from all three', () => {
  const shows = [
    { id: 'beetlejuice-2019', slug: 'beetlejuice-2019', title: 'Beetlejuice', category: 'broadway', previewsStartDate: '2019-03-28', closingDate: '2020-03-10' },
    { id: 'beetlejuice-2022', slug: 'beetlejuice-2022', title: 'Beetlejuice', category: 'broadway', openingDate: '2022-04-08', closingDate: '2023-01-08' },
    { id: 'beetlejuice-2025', slug: 'beetlejuice-2025', title: 'Beetlejuice', category: 'broadway', openingDate: '2025-10-08', closingDate: '2026-01-03' },
  ];
  const row = () => at(109_051_116, 806);
  const g = { 'beetlejuice-2019': row(), 'beetlejuice-2022': row(), 'beetlejuice-2025': row() };
  applyAllTimeAttribution(g, shows, { now: NOW });
  for (const s of shows) assert.equal(g[s.slug].allTime.gross, null, s.slug);
});

test('BRO-5016 Fela!: a closed run keeps its own row; the two-run total on the 2012 return is cleared, not moved onto it', () => {
  const shows = [
    { id: 'fela-2009', slug: 'fela-2009', title: 'Fela!', category: 'broadway', previewsStartDate: '2009-10-19', closingDate: '2011-01-02' },
    { id: 'fela-2012', slug: 'fela-2012', title: 'Fela!', category: 'broadway', previewsStartDate: '2012-07-09', closingDate: '2012-08-04' },
  ];
  const g = { 'fela-2009': at(27_110_350, 416), 'fela-2012': at(33_452_773, 529) };
  const r = applyAllTimeAttribution(g, shows, { now: NOW });
  assert.equal(r.moves.length, 0);
  assert.deepEqual(g['fela-2009'].allTime, { gross: 27_110_350, performances: 416, attendance: 1 });
  assert.equal(g['fela-2012'].allTime.gross, null);
});

test('apply on Mamma Mia!: the identical 2025 copy is gone and the 2001 row is untouched', () => {
  const shows = MAMMA.map((s) => ({ ...s, title: 'Mamma Mia!' }));
  const g = { 'mamma-mia': at(670_150_538, 5979, 7_876_073), 'mamma-mia-2001': at(670_150_538, 5979, 7_876_073) };
  applyAllTimeAttribution(g, shows, { now: NOW });
  assert.equal(g['mamma-mia'].allTime.gross, null);
  assert.deepEqual(g['mamma-mia-2001'].allTime, { gross: 670_150_538, performances: 5979, attendance: 7_876_073 });
});

// BRO-5016 follow-up: a cleared production gets its own run's totals back.
const { ownRunTotals, fillClearedFromHistory } = require('../../scripts/lib/alltime-attribution.js');
const weeksFrom = (start, end) => {
  const out = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 7 * 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const hist = (bySlug) => {
  const weeks = {};
  for (const [slug, [start, end, row]] of Object.entries(bySlug)) {
    for (const w of weeksFrom(start, end)) (weeks[w] ||= {})[slug] = { ...row };
  }
  return { weeks };
};
const ROW = { gross: 1_000_000.1, performances: 8, attendance: 8000 };

test('apply with history: the emptied 2025 Mamma Mia! (a move source) gets its own run total back as allTime', () => {
  const shows = MAMMA.map((s) => ({ ...s, title: 'Mamma Mia!' }));
  const g = { 'mamma-mia': at(670_150_538, 5979, 7_876_073) };
  const history = hist({ 'mamma-mia': ['2025-08-03', '2026-02-01', ROW] });
  const r = applyAllTimeAttribution(g, shows, { now: NOW, history });
  assert.deepEqual(r.moves.map((m) => [m.slug, m.to]), [['mamma-mia', 'mamma-mia-2001']]);
  assert.equal(g['mamma-mia-2001'].allTime.performances, 5979);
  assert.deepEqual(g['mamma-mia'].allTime, { gross: 27_000_002.7, performances: 216, attendance: 216_000 });
  assert.equal(g['mamma-mia'].partialRun, undefined);
  assert.deepEqual(r.fills, [{ slug: 'mamma-mia', status: 'complete', weeks: 27, gaps: 0, since: '2025-08-03', gross: 27_000_002.7 }]);
  assert.equal(g['mamma-mia'].allTimeSource, 'history');
});

test('history that starts after the first preview gives a partialRun with since, and allTime stays blank', () => {
  const show = bw('the-music-man-2000', '2000-04-11', '2001-12-30');
  const g = { 'the-music-man-2000': at(null, null, null) };
  const history = hist({ 'the-music-man-2000': ['2001-12-16', '2001-12-30', ROW] });
  const fills = fillClearedFromHistory(g, [show], history, [{ slug: 'the-music-man-2000' }], { now: NOW });
  assert.equal(fills[0].status, 'partial');
  assert.equal(g['the-music-man-2000'].allTime.gross, null);
  assert.deepEqual(g['the-music-man-2000'].partialRun, { gross: 3_000_000.3, performances: 24, attendance: 24_000, since: '2001-12-16' });
});

test('no previews date: the opening is the run start (a return engagement is complete from its opening week)', () => {
  const show = { id: 'beetlejuice-2025', slug: 'beetlejuice-2025', category: 'broadway', openingDate: '2025-10-08', closingDate: '2026-01-03' };
  const history = hist({ 'beetlejuice-2025': ['2025-10-12', '2026-01-04', ROW] });
  assert.equal(ownRunTotals(history, show, { now: NOW }).complete, true);
  // A missing count anywhere makes the run incomplete; a missing attendance only blanks attendance.
  history.weeks['2025-11-02']['beetlejuice-2025'].performances = null;
  history.weeks['2025-11-09']['beetlejuice-2025'].attendance = null;
  const own = ownRunTotals(history, show, { now: NOW });
  assert.equal(own.complete, false);
  assert.equal(own.attendance, null);
});

test('a running show counts to the newest week; a slug with a real allTime drops a stale partialRun; non-Broadway and uncleared slugs are untouched', () => {
  const running = bw('chicago', '1996-10-23', null);
  const ob = { ...bw('ob-show', '2025-01-05', '2025-03-01'), category: 'off-broadway' };
  const g = {
    chicago: { allTime: { gross: 9, performances: 9, attendance: 9 }, partialRun: { gross: 1, performances: 1, attendance: 1, since: '2001-12-16' } },
    'ob-show': at(null, null, null),
    other: at(null, null, null),
  };
  const history = hist({ 'ob-show': ['2025-01-05', '2025-03-02', ROW], other: ['2025-01-05', '2025-03-02', ROW] });
  const shows = [running, ob, bw('other', '2025-01-05', '2025-03-01')];
  const fills = fillClearedFromHistory(g, shows, history, [{ slug: 'ob-show' }], { now: NOW });
  assert.deepEqual(fills, []);
  assert.equal(g.chicago.partialRun, undefined);
  assert.equal(g['ob-show'].allTime.gross, null);
  assert.equal(g.other.allTime.gross, null);
  const h2 = hist({ chicago: ['1996-10-27', '2026-10-04', ROW] });
  assert.equal(ownRunTotals(h2, running, { now: NOW }).complete, true);
});

test('rows filed under the slug from an earlier run of the title are never summed (history not yet re-keyed)', () => {
  const show = { id: 'beetlejuice-2025', slug: 'beetlejuice-2025', category: 'broadway', openingDate: '2025-10-08', closingDate: '2026-01-03' };
  const history = hist({ 'beetlejuice-2025': ['2019-03-31', '2020-03-08', ROW] });
  for (const w of weeksFrom('2025-10-12', '2026-01-04')) (history.weeks[w] ||= {})['beetlejuice-2025'] = { ...ROW };
  const own = ownRunTotals(history, show, { now: NOW });
  assert.equal(own.weeks, 13);
  assert.equal(own.since, '2025-10-12');
  assert.equal(own.status, 'complete');
  // A run with only another run's rows gets nothing.
  assert.equal(ownRunTotals(hist({ 'porgy-1976': ['2011-12-18', '2012-09-30', ROW] }), bw('porgy-1976', '1976-09-10', '1977-01-09'), { now: NOW }), null);
});

test('a week missing inside the run, or a short end, leaves the production blank; a count over the run is a misfit', () => {
  const show = bw('dos-2026', '2026-03-06', '2026-08-09');
  const history = hist({ 'dos-2026': ['2026-03-08', '2026-08-09', ROW] });
  history.weeks['2026-03-29'] = { other: { ...ROW } };
  const g = { 'dos-2026': at(null, null, null) };
  const fills = fillClearedFromHistory(g, [show], history, [{ slug: 'dos-2026' }], { now: NOW });
  assert.deepEqual([fills[0].status, fills[0].gaps], ['gaps', 1]);
  assert.equal(g['dos-2026'].allTime.gross, null);
  assert.equal(g['dos-2026'].partialRun, undefined);
  const shortEnd = hist({ 'dos-2026': ['2026-03-08', '2026-06-07', ROW] });
  shortEnd.weeks['2026-08-09'] = { other: { ...ROW } };
  assert.equal(ownRunTotals(shortEnd, show, { now: NOW }).status, 'gaps');
  const heavy = hist({ 'dos-2026': ['2026-03-08', '2026-08-09', { ...ROW, performances: 40 }] });
  assert.equal(ownRunTotals(heavy, show, { now: NOW }).status, 'misfit');
});

test('holes are counted in calendar weeks: a week absent from the history is a gap, Broadway going dark in 2020 is not', () => {
  const show = bw('dos-2026', '2026-03-06', '2026-08-09');
  const history = hist({ 'dos-2026': ['2026-03-08', '2026-08-09', ROW] });
  delete history.weeks['2026-03-29'];
  const own = ownRunTotals(history, show, { now: NOW });
  assert.deepEqual([own.status, own.gaps], ['gaps', 1]);
  // A run spanning the COVID shutdown (no week keys 2020-03-15..2021-08-15) is complete.
  const covid = hist({ hadestown: ['2019-03-24', '2020-03-08', ROW] });
  for (const w of weeksFrom('2021-08-22', '2021-10-03')) (covid.weeks[w] ||= {}).hadestown = { ...ROW };
  const run = bw('hadestown', '2019-03-22', '2021-10-03');
  const c = ownRunTotals(covid, run, { now: NOW });
  assert.deepEqual([c.status, c.gaps], ['complete', 0]);
  // April 2018 is not a known gap: until the backfill stores those weeks, a
  // run across them is three weeks short; once stored, it is complete.
  const carousel = bw('carousel-2018', '2018-02-28', '2018-09-16');
  const h18 = hist({ 'carousel-2018': ['2018-03-04', '2018-09-16', ROW] });
  for (const w of ['2018-04-01', '2018-04-08', '2018-04-15']) delete h18.weeks[w];
  assert.deepEqual([ownRunTotals(h18, carousel, { now: NOW }).status, ownRunTotals(h18, carousel, { now: NOW }).gaps], ['gaps', 3]);
  for (const w of ['2018-04-01', '2018-04-08', '2018-04-15']) h18.weeks[w] = { 'carousel-2018': { ...ROW } };
  assert.equal(ownRunTotals(h18, carousel, { now: NOW }).status, 'complete');
});

test('a run whose first row is late but after the history starts is a missed week, not a "since" partial', () => {
  const show = bw('spring-2026', '2026-03-10', '2026-08-09');
  const history = hist({ older: ['2001-12-16', '2001-12-30', ROW], 'spring-2026': ['2026-04-12', '2026-08-09', ROW] });
  const own = ownRunTotals(history, show, { now: NOW });
  assert.equal(own.status, 'gaps');
});

test('a history-filled allTime is refreshed from the weekly rows on the next run, and dropped when the rows no longer support it', () => {
  const running = bw('revival-2026', '2026-05-01', null);
  const g = { 'revival-2026': { allTime: { gross: 1, performances: 8, attendance: 1 }, allTimeSource: 'history' } };
  const history = hist({ 'revival-2026': ['2026-05-03', '2026-10-04', ROW] });
  const fills = fillClearedFromHistory(g, [running], history, [], { now: NOW });
  assert.equal(fills[0].status, 'complete');
  assert.equal(g['revival-2026'].allTime.performances, 8 * 23);
  assert.equal(g['revival-2026'].allTimeSource, 'history');
  delete history.weeks['2026-06-07']['revival-2026'];
  history.weeks['2026-06-07'].other = { ...ROW };
  fillClearedFromHistory(g, [running], history, [], { now: NOW });
  assert.deepEqual(g['revival-2026'].allTime, { gross: null, performances: null, attendance: null });
  assert.equal(g['revival-2026'].allTimeSource, undefined);
});
