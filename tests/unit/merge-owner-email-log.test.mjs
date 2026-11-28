import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeOwnerEmailLog, keyOf } = require('../../scripts/lib/merge-owner-email-log.js');

const send = (ts, title, severity = 'error') => ({ ts, title, severity });

test('acceptance (task #809): two concurrent runs each send a DIFFERENT owner email — both survive', () => {
  // ours = the pushing run's local log (appended its own send).
  // remote = what landed on origin while we rebased (a concurrent run's send).
  const ours = [send('2026-08-02T10:00:00Z', 'base alert'), send('2026-08-02T10:05:00Z', 'alert A')];
  const remote = [send('2026-08-02T10:00:00Z', 'base alert'), send('2026-08-02T10:06:00Z', 'alert B')];

  const { merged, stats } = mergeOwnerEmailLog(ours, remote);
  const titles = merged.map((e) => e.title).sort();
  assert.deepEqual(titles, ['alert A', 'alert B', 'base alert']);
  assert.equal(stats.added, 1); // alert B re-added from remote
  assert.equal(stats.kept, 1); // base alert shared
});

test('remote-only entries are re-added (the silent drop this fixes)', () => {
  const ours = [send('2026-08-02T10:00:00Z', 'x')];
  const remote = [send('2026-08-02T10:00:00Z', 'x'), send('2026-08-02T11:00:00Z', 'y'), send('2026-08-02T12:00:00Z', 'z')];
  const { merged, stats } = mergeOwnerEmailLog(ours, remote);
  assert.deepEqual(merged.map((e) => e.title), ['x', 'y', 'z']);
  assert.equal(stats.added, 2);
});

test('exact duplicate (same ts+title+severity on both sides) collapses to one entry', () => {
  const ours = [send('2026-08-02T10:00:00Z', 'x')];
  const remote = [send('2026-08-02T10:00:00Z', 'x')];
  const { merged, stats } = mergeOwnerEmailLog(ours, remote);
  assert.equal(merged.length, 1);
  assert.equal(stats.kept, 1);
  assert.equal(stats.added, 0);
});

test('same ts+title but different severity are NOT duplicates (both survive)', () => {
  const ours = [send('2026-08-02T10:00:00Z', 'x', 'critical')];
  const remote = [send('2026-08-02T10:00:00Z', 'x', 'error')];
  const { merged } = mergeOwnerEmailLog(ours, remote);
  assert.equal(merged.length, 2);
});

test('two GENUINE sends of the same title at different timestamps both survive (not deduped)', () => {
  const ours = [send('2026-08-01T10:00:00Z', 'x')];
  const remote = [send('2026-08-01T10:00:00Z', 'x'), send('2026-08-02T10:00:00Z', 'x')];
  const { merged } = mergeOwnerEmailLog(ours, remote);
  assert.deepEqual(
    merged.map((e) => e.ts),
    ['2026-08-01T10:00:00Z', '2026-08-02T10:00:00Z'],
  );
});

test('order is deterministic: ours first, remote-only appended in remote order', () => {
  const ours = [send('2026-08-02T10:00:00Z', 'a'), send('2026-08-02T10:01:00Z', 'b')];
  const remote = [send('2026-08-02T09:00:00Z', 'c'), send('2026-08-02T10:01:00Z', 'b'), send('2026-08-02T09:30:00Z', 'd')];
  const { merged } = mergeOwnerEmailLog(ours, remote);
  assert.deepEqual(merged.map((e) => e.title), ['a', 'b', 'c', 'd']);
});

test('keyless entries (missing ts, title, or severity — corrupt line) never drop, appended verbatim from ours', () => {
  const ours = [{ title: 'no-ts', severity: 'error' }, { ts: '2026-08-02T10:00:00Z', severity: 'error' }, { ts: '2026-08-02T10:00:00Z', title: 'no-severity' }];
  const remote = [];
  const { merged } = mergeOwnerEmailLog(ours, remote);
  assert.equal(merged.length, 3);
});

test('empty ours/remote handled without throwing', () => {
  assert.deepEqual(mergeOwnerEmailLog([], []).merged, []);
  assert.deepEqual(mergeOwnerEmailLog(undefined, undefined).merged, []);
  const { merged } = mergeOwnerEmailLog([], [send('2026-08-02T10:00:00Z', 'x')]);
  assert.equal(merged.length, 1);
});

test('keyOf: null for missing ts, title, or severity, stable string otherwise', () => {
  assert.equal(keyOf(send('t', 'title', 's')), 't|title|s');
  assert.equal(keyOf({ title: 'x', severity: 'error' }), null);
  assert.equal(keyOf({ ts: 't', severity: 'error' }), null);
  assert.equal(keyOf({ ts: 't', title: 'x' }), null);
  assert.equal(keyOf(null), null);
});
