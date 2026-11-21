import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { rowsFromProfiles, appendRows, historyForSeason } = require('../../scripts/lib/season-payback-history.js');

const profile = (season, r) => ({ season, returnedCapital: { capital: 100e6, low: 10e6, mid: 20e6, high: 30e6, shows: 5, of: 6, ...r } });

test('one row per season with a returned estimate; seasons with none are skipped', () => {
  const rows = rowsFromProfiles([profile('2025-2026'), profile('2020-2021', { capital: 0, shows: 0 })], '2026-10-26');
  assert.deepEqual(rows, [{ date: '2026-10-26', season: '2025-2026', capital: 100e6, returnedLow: 10e6, returnedMid: 20e6, returnedHigh: 30e6, shows: 5, of: 6 }]);
});

test('a daily run adds a row per season; a same-day rerun replaces rather than duplicates', () => {
  const day1 = rowsFromProfiles([profile('2025-2026'), profile('2024-2025')], '2026-10-25');
  const day2 = rowsFromProfiles([profile('2025-2026', { mid: 25e6 }), profile('2024-2025')], '2026-10-26');
  let h = appendRows([], day1);
  h = appendRows(h, day2);
  h = appendRows(h, day2);
  assert.equal(h.length, 4);
  const s = historyForSeason(h, '2025-2026');
  assert.deepEqual(s.map((r) => [r.date, r.returnedMid]), [['2026-10-25', 20e6], ['2026-10-26', 25e6]]);
  assert.deepEqual(appendRows(null, day1).length, 2);
});
