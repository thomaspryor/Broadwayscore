import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeDiaryShows, keyOf } = require('../../scripts/lib/merge-diary-shows.js');

const entry = (mezzanineId, extra = {}) => ({
  id: `${mezzanineId}-slug`,
  title: mezzanineId,
  mezzanineId,
  ...extra,
});

test('acceptance: two racing writers each add a different new show — both survive', () => {
  // ours = the pushing run (added show A), remote = the run that won the race (added show B).
  const ours = { shows: [entry('base1'), entry('A')], lastUpdated: '2026-07-20T10:00:00Z' };
  const remote = { shows: [entry('base1'), entry('B')], lastUpdated: '2026-07-20T10:05:00Z' };

  const { merged, stats } = mergeDiaryShows(ours, remote);
  const ids = merged.shows.map((s) => s.mezzanineId).sort();
  assert.deepEqual(ids, ['A', 'B', 'base1']);
  assert.equal(stats.added, 1); // B re-added from remote
  assert.equal(stats.kept, 1); // base1 shared
});

test('remote-only entries are re-added (the drop this fixes)', () => {
  const ours = { shows: [entry('x')] };
  const remote = { shows: [entry('x'), entry('y'), entry('z')] };
  const { merged, stats } = mergeDiaryShows(ours, remote);
  assert.deepEqual(merged.shows.map((s) => s.mezzanineId), ['x', 'y', 'z']);
  assert.equal(stats.added, 2);
});

test('ours wins on a shared key (matches -X ours)', () => {
  const ours = { shows: [entry('x', { audienceScore: 90 })] };
  const remote = { shows: [entry('x', { audienceScore: 50 })] };
  const { merged } = mergeDiaryShows(ours, remote);
  assert.equal(merged.shows.length, 1);
  assert.equal(merged.shows[0].audienceScore, 90);
});

test('order is deterministic: ours first, remote-only appended', () => {
  const ours = { shows: [entry('a'), entry('b')] };
  const remote = { shows: [entry('c'), entry('b'), entry('d')] };
  const { merged } = mergeDiaryShows(ours, remote);
  assert.deepEqual(merged.shows.map((s) => s.mezzanineId), ['a', 'b', 'c', 'd']);
});

test('falls back to id when mezzanineId is absent', () => {
  const ours = { shows: [{ id: 'legacy-1', title: 'Legacy' }] };
  const remote = { shows: [{ id: 'legacy-1', title: 'Legacy dup' }, { id: 'legacy-2', title: 'New' }] };
  const { merged, stats } = mergeDiaryShows(ours, remote);
  assert.deepEqual(merged.shows.map((s) => s.id), ['legacy-1', 'legacy-2']);
  assert.equal(stats.added, 1);
  assert.equal(merged.shows[0].title, 'Legacy'); // ours wins on shared id
});

test('keyless entries (no mezzanineId, no id) never drop — appended verbatim', () => {
  const ours = { shows: [{ title: 'keyless-ours' }] };
  const remote = { shows: [{ title: 'keyless-remote' }] };
  const { merged } = mergeDiaryShows(ours, remote);
  assert.equal(merged.shows.length, 2);
  assert.equal(keyOf(ours.shows[0]), null);
});

test('lastUpdated becomes the newer timestamp', () => {
  const older = '2026-07-20T10:00:00Z';
  const newer = '2026-07-20T11:00:00Z';
  assert.equal(mergeDiaryShows({ shows: [], lastUpdated: older }, { shows: [], lastUpdated: newer }).merged.lastUpdated, newer);
  assert.equal(mergeDiaryShows({ shows: [], lastUpdated: newer }, { shows: [], lastUpdated: older }).merged.lastUpdated, newer);
});

test('tolerates missing/malformed inputs', () => {
  assert.deepEqual(mergeDiaryShows(null, null).merged.shows, []);
  assert.deepEqual(mergeDiaryShows({}, {}).merged.shows, []);
  assert.deepEqual(mergeDiaryShows({ shows: 'nope' }, { shows: null }).merged.shows, []);
});
