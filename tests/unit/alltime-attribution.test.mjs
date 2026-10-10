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

test('an impossible count with no same-title run that fits is left alone; an undated or open-ended sibling is not a fit', () => {
  const shows = [
    { id: 'x-2024', slug: 'x-2024', title: 'X', category: 'broadway', previewsStartDate: '2024-03-01', closingDate: '2024-04-01' },
    { id: 'x-1970', slug: 'x-1970', title: 'X', category: 'broadway', previewsStartDate: '1970-01-01', closingDate: null },
    { id: 'x-1990', slug: 'x-1990', title: 'X', category: 'broadway' },
  ];
  assert.deepEqual(misplacedAllTimeMoves({ 'x-2024': at(1, 500) }, shows, { now: NOW }), []);
});

test('apply on Mamma Mia!: the identical 2025 copy is gone and the 2001 row is untouched', () => {
  const shows = MAMMA.map((s) => ({ ...s, title: 'Mamma Mia!' }));
  const g = { 'mamma-mia': at(670_150_538, 5979, 7_876_073), 'mamma-mia-2001': at(670_150_538, 5979, 7_876_073) };
  applyAllTimeAttribution(g, shows, { now: NOW });
  assert.equal(g['mamma-mia'].allTime.gross, null);
  assert.deepEqual(g['mamma-mia-2001'].allTime, { gross: 670_150_538, performances: 5979, attendance: 7_876_073 });
});
