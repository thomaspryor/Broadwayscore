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

// The map is a {closed, open} TALLY per normalized title, not a single state:
// titles are NOT unique on this board (linear-import-rules.js:378 measured 28
// titles shared by 69 distinct un-Done cards).
const t = (closed, open) => ({ closed, open });
const states = new Map([
  ['done thing', t(1, 0)],
  ['cancelled thing', t(1, 0)],
  ['dupe thing', t(1, 0)],
  ['live thing', t(0, 1)],
  ['backlog thing', t(0, 1)],
  ['todo thing', t(0, 1)],
  // one closed + one still-open issue share this title
  ['collision thing', t(1, 1)],
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
  assert.deepEqual(map.get('done thing'), { closed: 1, open: 0 });
  assert.deepEqual(map.get('live thing'), { closed: 0, open: 1 });
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

test('TITLE COLLISION: a title with any still-open twin is NEVER dropped', () => {
  // The regression this guards: a last-write-wins lookup let one archived Done
  // issue retire a live card sharing its name — the failure the whole check
  // exists to catch, inverted.
  const { kept, resolved } = partitionBucket([card('Collision thing')], states);
  assert.equal(resolved.length, 0, 'must not drop a card whose title also has an OPEN Linear issue');
  assert.deepEqual(kept.map((c) => c.name), ['Collision thing']);
});

test('reconcileStuckBuckets also reconciles the awaitingRecheck/parked carve-outs', () => {
  // These feed the "(N awaiting recheck ... not counted)" note and the parked
  // resume hint; unreconciled they would cite work Linear says is already Done.
  const out = reconcileStuckBuckets(
    {
      pausedCritical: [],
      orphaned: [],
      pausedStale: [],
      pausedAwaitingRecheck: [card('Done thing'), card('Live thing')],
      pausedParked: [card('Dupe thing'), card('Collision thing')],
    },
    states
  );
  assert.deepEqual(out.pausedAwaitingRecheck.map((c) => c.name), ['Live thing']);
  assert.deepEqual(out.pausedParked.map((c) => c.name), ['Collision thing']);
});

test('carve-out buckets survive the no-op path untouched', () => {
  const out = reconcileStuckBuckets(
    { pausedAwaitingRecheck: [card('Done thing')], pausedParked: [card('Dupe thing')] },
    new Map()
  );
  assert.equal(out.applied, false);
  assert.equal(out.pausedAwaitingRecheck.length, 1);
  assert.equal(out.pausedParked.length, 1);
});

test('fetchLinearIssueStates tallies collisions instead of last-write-wins', async () => {
  const pages = [{
    nodes: [
      { title: 'Shared', state: { type: 'completed' } },
      { title: 'shared', state: { type: 'started' } },
      { title: 'Solo', state: { type: 'canceled' } },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  }];
  let i = 0;
  const map = await fetchLinearIssueStates({
    getTeam: async () => ({ id: 'T' }),
    graphql: async () => ({ team: { issues: pages[i++] } }),
  });
  assert.deepEqual(map.get('shared'), { closed: 1, open: 1 }, 'both issues counted, neither overwritten');
  assert.deepEqual(map.get('solo'), { closed: 1, open: 0 });
});

test('fetchLinearIssueStates bounds each attempt and stops at the wall-clock deadline', async () => {
  const seen = [];
  let clock = 0;
  const map = await fetchLinearIssueStates(
    {
      getTeam: async () => ({ id: 'T' }),
      graphql: async (_q, _v, opts) => {
        seen.push(opts);
        clock += 40_000; // each page burns 40s of the budget
        return {
          team: {
            issues: {
              nodes: [{ title: `page${seen.length}`, state: { type: 'started' } }],
              pageInfo: { hasNextPage: true, endCursor: 'c' },
            },
          },
        };
      },
    },
    { deadlineMs: 60_000, now: () => clock }
  );
  assert.equal(seen.length, 2, 'stops once the deadline passes instead of paginating forever');
  assert.equal(seen[0].timeoutMs, 8000, 'per-attempt timeout is bounded, not the 30s client default');
  assert.equal(seen[0].maxAttempts, 2);
  assert.equal(map.size, 2, 'the partial map is returned — a missing title reads as no-twin and keeps the card');
});
