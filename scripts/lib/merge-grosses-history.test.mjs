import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeGrossesHistory } from './merge-grosses-history.js';

test('mergeGrossesHistory: unions a remote-only week wholesale', () => {
  const ours = { weeks: { '2026-01-01': { a: { gross: 1 } } } };
  const remote = { weeks: { '2026-01-01': { a: { gross: 1 } }, '2026-01-08': { a: { gross: 2 } } } };
  const { merged, stats } = mergeGrossesHistory(ours, remote);
  assert.deepEqual(Object.keys(merged.weeks).sort(), ['2026-01-01', '2026-01-08']);
  assert.equal(stats.weeksAdded, 1);
});

test('mergeGrossesHistory: unions slugs within a shared week', () => {
  const ours = { weeks: { '2026-01-01': { a: { gross: 1 } } } };
  const remote = { weeks: { '2026-01-01': { b: { gross: 2 } } } };
  const { merged, stats } = mergeGrossesHistory(ours, remote);
  assert.deepEqual(Object.keys(merged.weeks['2026-01-01']).sort(), ['a', 'b']);
  assert.equal(stats.slugsAdded, 1);
});

test('mergeGrossesHistory: ours wins on a shared week+slug', () => {
  const ours = { weeks: { '2026-01-01': { a: { gross: 111 } } } };
  const remote = { weeks: { '2026-01-01': { a: { gross: 999 } } } };
  const { merged } = mergeGrossesHistory(ours, remote);
  assert.equal(merged.weeks['2026-01-01'].a.gross, 111);
});

test('mergeGrossesHistory: keeps a local-only week untouched', () => {
  const ours = { weeks: { '2026-01-01': { a: { gross: 1 } } } };
  const remote = { weeks: {} };
  const { merged } = mergeGrossesHistory(ours, remote);
  assert.deepEqual(merged.weeks['2026-01-01'], { a: { gross: 1 } });
});

test('mergeGrossesHistory: handles missing weeks key on either side', () => {
  const { merged } = mergeGrossesHistory(undefined, { weeks: { '2026-01-01': { a: {} } } });
  assert.ok(merged.weeks['2026-01-01']);
});
