import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeGrossesHistory } from './merge-grosses-history.js';

test('mergeGrossesHistory: unions a remote-only week wholesale', () => {
  const ours = { weeks: { '2026-01-04': { a: { gross: 1 } } } };
  const remote = { weeks: { '2026-01-04': { a: { gross: 1 } }, '2026-01-11': { a: { gross: 2 } } } };
  const { merged, stats } = mergeGrossesHistory(ours, remote);
  assert.deepEqual(Object.keys(merged.weeks).sort(), ['2026-01-04', '2026-01-11']);
  assert.equal(stats.weeksAdded, 1);
});

test('mergeGrossesHistory: unions slugs within a shared week', () => {
  const ours = { weeks: { '2026-01-04': { a: { gross: 1 } } } };
  const remote = { weeks: { '2026-01-04': { b: { gross: 2 } } } };
  const { merged, stats } = mergeGrossesHistory(ours, remote);
  assert.deepEqual(Object.keys(merged.weeks['2026-01-04']).sort(), ['a', 'b']);
  assert.equal(stats.slugsAdded, 1);
});

test('mergeGrossesHistory: ours wins on a shared week+slug', () => {
  const ours = { weeks: { '2026-01-04': { a: { gross: 111 } } } };
  const remote = { weeks: { '2026-01-04': { a: { gross: 999 } } } };
  const { merged } = mergeGrossesHistory(ours, remote);
  assert.equal(merged.weeks['2026-01-04'].a.gross, 111);
});

test('mergeGrossesHistory: unions published weekTotals, ours wins per week (BRO-4988)', () => {
  const ours = { _meta: { lastUpdated: '2026-10-06T00:00:00Z', weekTotals: { '2026-10-04': { gross: 1, showCount: 30 } } }, weeks: {} };
  const remote = { _meta: { lastUpdated: '2026-10-07T00:00:00Z', weekTotals: { '2026-10-04': { gross: 9, showCount: 9 }, '2026-09-27': { gross: 2, showCount: 29 } } }, weeks: {} };
  const { merged } = mergeGrossesHistory(ours, remote);
  assert.deepEqual(merged._meta.weekTotals, { '2026-10-04': { gross: 1, showCount: 30 }, '2026-09-27': { gross: 2, showCount: 29 } });
  assert.equal(merged._meta.lastUpdated, '2026-10-07T00:00:00Z');
});

test('mergeGrossesHistory: keeps a local-only week untouched', () => {
  const ours = { weeks: { '2026-01-04': { a: { gross: 1 } } } };
  const remote = { weeks: {} };
  const { merged } = mergeGrossesHistory(ours, remote);
  assert.deepEqual(merged.weeks['2026-01-04'], { a: { gross: 1 } });
});

test('mergeGrossesHistory: handles missing weeks key on either side', () => {
  const { merged } = mergeGrossesHistory(undefined, { weeks: { '2026-01-04': { a: {} } } });
  assert.ok(merged.weeks['2026-01-04']);
});
