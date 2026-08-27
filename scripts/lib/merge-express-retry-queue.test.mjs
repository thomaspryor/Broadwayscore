// scripts/lib/merge-express-retry-queue.test.mjs — node:test
// Run: node --test scripts/lib/merge-express-retry-queue.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mergeExpressRetryQueue, keyOf } from './merge-express-retry-queue.js';

test('keyOf: showId + queuedAt', () => {
  assert.equal(keyOf({ showId: 'a', queuedAt: '2026-08-25T09:00:00.000Z' }), 'a|2026-08-25T09:00:00.000Z');
  assert.equal(keyOf({ showId: 'a' }), null);
  assert.equal(keyOf(null), null);
});

test('union: entries present on only one side both survive', () => {
  const ours = { entries: [{ showId: 'show-a', queuedAt: 't1', attempted: false }] };
  const remote = { entries: [{ showId: 'show-b', queuedAt: 't1', attempted: false }] };
  const { merged, stats } = mergeExpressRetryQueue(ours, remote);
  assert.equal(merged.entries.length, 2);
  assert.deepEqual(merged.entries.map((e) => e.showId).sort(), ['show-a', 'show-b']);
  assert.equal(stats.added, 1);
});

test('collision, both un-attempted: keep ours', () => {
  const ours = { entries: [{ showId: 'show-a', queuedAt: 't1', attempted: false, market: 'broadway' }] };
  const remote = { entries: [{ showId: 'show-a', queuedAt: 't1', attempted: false, market: 'west-end' }] };
  const { merged } = mergeExpressRetryQueue(ours, remote);
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].market, 'broadway');
});

test('collision, remote attempted + ours not: remote wins (never undispatch)', () => {
  const ours = { entries: [{ showId: 'show-a', queuedAt: 't1', attempted: false }] };
  const remote = { entries: [{ showId: 'show-a', queuedAt: 't1', attempted: true, attemptedAt: 't2' }] };
  const { merged, stats } = mergeExpressRetryQueue(ours, remote);
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].attempted, true);
  assert.equal(stats.resolvedToRemoteAttempted, 1);
});

test('collision, ours attempted + remote not: ours wins', () => {
  const ours = { entries: [{ showId: 'show-a', queuedAt: 't1', attempted: true }] };
  const remote = { entries: [{ showId: 'show-a', queuedAt: 't1', attempted: false }] };
  const { merged } = mergeExpressRetryQueue(ours, remote);
  assert.equal(merged.entries[0].attempted, true);
});

test('same show, different queuedAt: both entries kept (not the same key)', () => {
  const ours = { entries: [{ showId: 'show-a', queuedAt: 't1', attempted: true }] };
  const remote = { entries: [{ showId: 'show-a', queuedAt: 't2', attempted: false }] };
  const { merged } = mergeExpressRetryQueue(ours, remote);
  assert.equal(merged.entries.length, 2);
});

test('missing/malformed input defaults to empty entries array', () => {
  const { merged } = mergeExpressRetryQueue(null, undefined);
  assert.deepEqual(merged.entries, []);
});

test('multi-show opening night: two concurrent Express runs each add one show, both survive after two-way merge', () => {
  // Simulates the actual race: run A pushes first (remote now has show-a),
  // run B's local commit only has show-b, rebase conflicts, merge resolves.
  const runBLocal = { entries: [{ showId: 'show-b', queuedAt: 't1', attempted: false }] };
  const remoteAfterRunA = { entries: [{ showId: 'show-a', queuedAt: 't1', attempted: false }] };
  const { merged } = mergeExpressRetryQueue(runBLocal, remoteAfterRunA);
  assert.deepEqual(merged.entries.map((e) => e.showId).sort(), ['show-a', 'show-b']);
});
