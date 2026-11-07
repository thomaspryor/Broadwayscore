import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeBwwRoundupLedger, keyOf } = require('../../scripts/lib/merge-bww-roundup-ledger.js');

const miss = (ts, showId) => ({ ts, showId });

test('acceptance (task #698): two concurrent poller runs each append a miss for a DIFFERENT show — both survive', () => {
  // ours = the pushing run's local ledger (appended a miss for show A).
  // remote = what landed on origin while we rebased (a concurrent run's miss for show B).
  const ours = [miss('2026-07-30T10:00:00Z', 'base-show'), miss('2026-07-30T10:05:00Z', 'show-a')];
  const remote = [miss('2026-07-30T10:00:00Z', 'base-show'), miss('2026-07-30T10:06:00Z', 'show-b')];

  const { merged, stats } = mergeBwwRoundupLedger(ours, remote);
  const showIds = merged.map((e) => e.showId).sort();
  assert.deepEqual(showIds, ['base-show', 'show-a', 'show-b']);
  assert.equal(stats.added, 1); // show-b re-added from remote
  assert.equal(stats.kept, 1); // base-show shared
});

test('remote-only entries are re-added (the silent drop this fixes)', () => {
  const ours = [miss('2026-07-30T10:00:00Z', 'x')];
  const remote = [miss('2026-07-30T10:00:00Z', 'x'), miss('2026-07-30T11:00:00Z', 'y'), miss('2026-07-30T12:00:00Z', 'z')];
  const { merged, stats } = mergeBwwRoundupLedger(ours, remote);
  assert.deepEqual(merged.map((e) => e.showId), ['x', 'y', 'z']);
  assert.equal(stats.added, 2);
});

test('exact duplicate (same ts+showId on both sides) collapses to one entry', () => {
  const ours = [miss('2026-07-30T10:00:00Z', 'x')];
  const remote = [miss('2026-07-30T10:00:00Z', 'x')];
  const { merged, stats } = mergeBwwRoundupLedger(ours, remote);
  assert.equal(merged.length, 1);
  assert.equal(stats.kept, 1);
  assert.equal(stats.added, 0);
});

test('two GENUINE misses on the same show at different timestamps both survive (not deduped)', () => {
  const ours = [miss('2026-07-29T10:00:00Z', 'x')];
  const remote = [miss('2026-07-29T10:00:00Z', 'x'), miss('2026-07-30T10:00:00Z', 'x')];
  const { merged } = mergeBwwRoundupLedger(ours, remote);
  assert.deepEqual(
    merged.map((e) => e.ts),
    ['2026-07-29T10:00:00Z', '2026-07-30T10:00:00Z'],
  );
});

test('order is deterministic: ours first, remote-only appended in remote order', () => {
  const ours = [miss('2026-07-30T10:00:00Z', 'a'), miss('2026-07-30T10:01:00Z', 'b')];
  const remote = [miss('2026-07-30T09:00:00Z', 'c'), miss('2026-07-30T10:01:00Z', 'b'), miss('2026-07-30T09:30:00Z', 'd')];
  const { merged } = mergeBwwRoundupLedger(ours, remote);
  assert.deepEqual(merged.map((e) => e.showId), ['a', 'b', 'c', 'd']);
});

test('keyless entries (missing ts or showId — corrupt line) never drop, appended verbatim from ours', () => {
  const ours = [{ showId: 'no-ts' }, { ts: '2026-07-30T10:00:00Z' }];
  const remote = [];
  const { merged } = mergeBwwRoundupLedger(ours, remote);
  assert.equal(merged.length, 2);
});

test('empty ours/remote handled without throwing', () => {
  assert.deepEqual(mergeBwwRoundupLedger([], []).merged, []);
  assert.deepEqual(mergeBwwRoundupLedger(undefined, undefined).merged, []);
  const { merged } = mergeBwwRoundupLedger([], [miss('2026-07-30T10:00:00Z', 'x')]);
  assert.equal(merged.length, 1);
});

test('keyOf: null for missing ts or showId, stable string otherwise', () => {
  assert.equal(keyOf(miss('t', 's')), 't|s');
  assert.equal(keyOf({ showId: 's' }), null);
  assert.equal(keyOf({ ts: 't' }), null);
  assert.equal(keyOf(null), null);
});
