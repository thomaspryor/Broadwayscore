/**
 * Daily season payback history (scripts/lib/season-payback-history.js, BRO-6335):
 * one row per season per day, reruns replace the day, trend needs a week.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { rowFor, upsertRows, seasonRows, trendFor } = createRequire(import.meta.url)('../../scripts/lib/season-payback-history.js');

const profile = (season, capital, low, mid, high) => ({ season, returnedCapital: { capital, low, mid, high } });
const row = (date, mid, season = '2024-2025') => ({ date, season, capital: 100, returnedLow: mid - 1, returnedMid: mid, returnedHigh: mid + 1 });

test('rowFor rounds to whole dollars', () => {
  assert.deepEqual(rowFor('2026-10-26', profile('2024-2025', 100.4, 10.4, 20.6, 30.5)), {
    date: '2026-10-26', season: '2024-2025', capital: 100, returnedLow: 10, returnedMid: 21, returnedHigh: 31,
  });
});

test('upsertRows replaces only that day and season, keeps order', () => {
  const h = upsertRows({ rows: [] }, '2026-10-25', [row('2026-10-25', 5), row('2026-10-25', 7, '2023-2024')]);
  const again = upsertRows(h, '2026-10-26', [row('2026-10-26', 6)]);
  const rerun = upsertRows(again, '2026-10-26', [row('2026-10-26', 9)]);
  assert.equal(rerun.rows.length, 3);
  assert.deepEqual(seasonRows(rerun, '2024-2025').map((r) => r.returnedMid), [5, 9]);
  assert.equal(seasonRows(rerun, '2023-2024').length, 1);
  assert.equal(upsertRows(null, '2026-10-26', [row('2026-10-26', 1)]).rows.length, 1);
});

test('trendFor: nothing under a week, then oldest row, then the row 28+ days back', () => {
  assert.equal(trendFor([row('2026-10-20', 5)]), null);
  assert.equal(trendFor([row('2026-10-24', 5), row('2026-10-26', 6)]), null);
  const week = trendFor([row('2026-10-19', 5), row('2026-10-26', 8)]);
  assert.equal(week.change, 3);
  const month = trendFor([row('2026-08-01', 1), row('2026-09-20', 4), row('2026-10-01', 6), row('2026-10-26', 9)]);
  assert.equal(month.from.date, '2026-09-20');
  assert.equal(month.change, 5);
});
