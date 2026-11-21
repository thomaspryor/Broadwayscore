// Unit tests for scripts/lib/grosses-lookup.js (BRO-5016): a production reads
// only its own key, never another production's through a year-stripped or
// prefix fallback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { makeGrossesLookup } = require('../../scripts/lib/grosses-lookup.js');

const history = { weeks: {
  '2014-06-01': { 'cabaret-2014': { gross: 1 } },
  '2025-01-05': { 'cabaret-2024': { gross: 2 }, 'doubt-2005': { gross: 3 } },
} };
const grosses = { shows: { ragtime: { allTime: { gross: 9 } }, 'cabaret-2024': { allTime: { gross: 5 } } } };

test('exact keys resolve; another production of the title never does', () => {
  const L = makeGrossesLookup(grosses, history);
  assert.equal(L.resolveWeeklySlug('cabaret-2024', 'cabaret-2024'), 'cabaret-2024');
  assert.deepEqual(Object.keys(L.getWeeklyData('cabaret-2014', 'cabaret-2014')), ['2014-06-01']);
  // doubt (Doubt 2024) has no key of its own: no data, not doubt-2005's.
  assert.equal(L.resolveWeeklySlug('doubt', 'doubt-2024'), null);
  assert.equal(L.getWeeklyData('cabaret-1987', 'cabaret-1987'), null);
  // ragtime-2009 must not read the 2025 revival's (slug "ragtime") all-time row.
  assert.equal(L.getGrossesAllTime('ragtime-2009', 'ragtime-2009'), null);
  assert.deepEqual(L.getGrossesAllTime('cabaret-2024'), { gross: 5 });
});

test('a production with weekly rows but no all-time row gets the sum of its own weeks', () => {
  const h = { weeks: {
    '2022-01-02': { 'the-music-man-2022': { gross: 3000000, performances: 8, attendance: 11000 } },
    '2022-01-09': { 'the-music-man-2022': { gross: 3100000, performances: 7, attendance: 10500 }, 'cabaret-2024': { gross: 2 } },
  } };
  const L = makeGrossesLookup(grosses, h);
  assert.deepEqual(L.getGrossesAllTime('the-music-man-2022', 'the-music-man-2022'),
    { gross: 6100000, performances: 15, attendance: 21500, fromWeekly: true });
  // An all-time row still wins over the weeks.
  assert.deepEqual(L.getGrossesAllTime('cabaret-2024'), { gross: 5 });
  // No rows of its own: still nothing.
  assert.equal(L.getGrossesAllTime('ragtime-2009', 'ragtime-2009'), null);
  // Weeks that all gross zero sum to nothing.
  const z = makeGrossesLookup({ shows: {} }, { weeks: { '2022-01-02': { 'dark-show': { gross: 0 } } } });
  assert.equal(z.getGrossesAllTime('dark-show'), null);
});

test('the recoupment scripts use the shared lookup, not their own fuzzy copy', () => {
  for (const f of ['calculate-recoupment.js', 'merge-model-recoupment.js']) {
    const src = fs.readFileSync(new URL(`../../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /makeGrossesLookup\(grosses, grossesHistory\)/, f);
    assert.doesNotMatch(src, /function resolveWeeklySlug/, f);
  }
});
