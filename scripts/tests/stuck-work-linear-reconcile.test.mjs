/**
 * Tests for the Notion→Linear stuck-work reconcile (BRO-104).
 *
 * The bug being guarded: the "Stuck work:" digest rows count Notion cards, but
 * the board moved to Linear, so cards closed in Linear sit in Notion forever
 * and the rows grow without bound. The reconcile drops a card only when its
 * Linear twin is explicitly closed — the "no twin at all" case MUST keep
 * counting, because the Notion→Linear mirror froze at task 1285 and anything
 * filed in Notion afterwards has no twin.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeTitle,
  partitionBucket,
  reconcileStuckBuckets,
  fetchLinearIssueStates,
} = require('../lib/stuck-work-linear-reconcile.js');

const card = (name) => ({ name, idleHours: 100 });

const states = new Map([
  ['done thing', 'completed'],
  ['cancelled thing', 'canceled'],
  ['dupe thing', 'duplicate'],
  ['live thing', 'started'],
  ['backlog thing', 'backlog'],
  ['todo thing', 'unstarted'],
]);

test('normalizeTitle collapses case and whitespace but keeps punctuation', () => {
  assert.equal(normalizeTitle('  P0:  Fix   The Thing '), 'p0: fix the thing');
  assert.equal(normalizeTitle('P0: Fix The Thing'), normalizeTitle('p0: fix the thing'));
  // Punctuation is meaningful and identical on both boards — must not be stripped.
  assert.notEqual(normalizeTitle('P0: fix'), normalizeTitle('P0 fix'));
  assert.equal(normalizeTitle(null), '');
  assert.equal(normalizeTitle(undefined), '');
});

test('partitionBucket drops only closed twins; open and no-twin keep counting', () => {
  const { kept, resolved } = partitionBucket(
    [
      card('Done thing'),
      card('Cancelled thing'),
      card('Dupe thing'),
      card('Live thing'),
      card('Backlog thing'),
      card('Todo thing'),
      card('Notion-only thing filed after the mirror froze'),
    ],
    states
  );
  assert.deepEqual(resolved.map((c) => c.name), ['Done thing', 'Cancelled thing', 'Dupe thing']);
  assert.deepEqual(kept.map((c) => c.name), [
    'Live thing',
    'Backlog thing',
    'Todo thing',
    'Notion-only thing filed after the mirror froze',
  ]);
});

test('a card with NO Linear twin is never dropped (mirror froze at task 1285)', () => {
  const { kept, resolved } = partitionBucket([card('never mirrored')], states);
  assert.equal(resolved.length, 0);
  assert.equal(kept.length, 1);
});

test('reconcileStuckBuckets reports per-bucket resolved counts', () => {
  const out = reconcileStuckBuckets(
    {
      pausedCritical: [card('Done thing'), card('Live thing')],
      orphaned: [card('Cancelled thing'), card('Dupe thing'), card('unknown one')],
      pausedStale: [card('Backlog thing')],
    },
    states
  );
  assert.equal(out.applied, true);
  assert.deepEqual(out.pausedCritical.map((c) => c.name), ['Live thing']);
  assert.deepEqual(out.orphaned.map((c) => c.name), ['unknown one']);
  assert.deepEqual(out.pausedStale.map((c) => c.name), ['Backlog thing']);
  assert.deepEqual(out.resolvedCounts, {
    pausedCritical: 1, orphaned: 2, pausedStale: 0, total: 3,
  });
});

test('an unreachable/empty Linear is a NO-OP, never a shrink', () => {
  const buckets = {
    pausedCritical: [card('Done thing')],
    orphaned: [card('Cancelled thing')],
    pausedStale: [card('Dupe thing')],
  };
  for (const empty of [null, undefined, new Map()]) {
    const out = reconcileStuckBuckets(buckets, empty);
    assert.equal(out.applied, false, 'must not claim it reconciled');
    assert.equal(out.pausedCritical.length, 1);
    assert.equal(out.orphaned.length, 1);
    assert.equal(out.pausedStale.length, 1);
    assert.equal(out.resolvedCounts.total, 0);
  }
});

test('missing buckets do not throw', () => {
  const out = reconcileStuckBuckets({}, states);
  assert.deepEqual(out.pausedCritical, []);
  assert.deepEqual(out.orphaned, []);
  assert.deepEqual(out.pausedStale, []);
});

test('fetchLinearIssueStates paginates and normalizes titles', async () => {
  const pages = [
    {
      nodes: [{ title: '  Done   Thing ', state: { type: 'completed' } }],
      pageInfo: { hasNextPage: true, endCursor: 'c1' },
    },
    {
      nodes: [
        { title: 'Live Thing', state: { type: 'started' } },
        { title: 'no state', state: null },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  ];
  let i = 0;
  const map = await fetchLinearIssueStates({
    getTeam: async () => ({ id: 'T' }),
    graphql: async () => ({ team: { issues: pages[i++] } }),
  });
  assert.equal(map.get('done thing'), 'completed');
  assert.equal(map.get('live thing'), 'started');
  assert.equal(map.has('no state'), false, 'rows without a state are skipped, not stored as undefined');
  assert.equal(map.size, 2);
});

test('fetchLinearIssueStates returns an empty map when Linear throws (degrades to no-op)', async () => {
  const map = await fetchLinearIssueStates({
    getTeam: async () => { throw new Error('401 unauthorized'); },
    graphql: async () => { throw new Error('unreachable'); },
  });
  assert.equal(map.size, 0);
  // and that empty map must make the reconcile a no-op
  const out = reconcileStuckBuckets({ pausedCritical: [card('Done thing')] }, map);
  assert.equal(out.applied, false);
  assert.equal(out.pausedCritical.length, 1);
});
