/**
 * linear-open-backlog-source.test.mjs — BRO-3551.
 *
 * mapIssueToCandidate (Linear GraphQL issue node -> the shape
 * selectOpenBacklogSweepCandidates expects) and fetchOpenBacklogSweepCandidates
 * (pagination + fail-loud-on-error), mirroring
 * autonomous-acceptance-recheck-linear.test.mjs's coverage of the sibling
 * linear-recheck-source.js module.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mapIssueToCandidate, fetchOpenBacklogSweepCandidates } = require('./linear-open-backlog-source.js');
const { selectOpenBacklogSweepCandidates } = require('./autonomous-recheck-core.js');

function backlogIssue({ id = 'BRO-9001', title = 'Fix the thing', priority = 2, stateType = 'backlog', description = '## Acceptance criteria\n`node --test scripts/lib/some.test.mjs`' } = {}) {
  return {
    identifier: id,
    title,
    description,
    priority,
    state: { name: stateType === 'backlog' ? 'Backlog' : 'Todo', type: stateType },
    comments: { nodes: [{ body: 'Dispatched to workspace X at 2026-09-08T00:00:00.000Z', createdAt: '2026-09-08T00:00:00.000Z' }] },
  };
}

test('BRO-3551: mapIssueToCandidate maps a raw Linear node into the sweep-candidate shape', () => {
  const candidate = mapIssueToCandidate(backlogIssue());
  assert.deepEqual(candidate, {
    id: 'BRO-9001',
    name: 'Fix the thing',
    priority: 2,
    stateType: 'backlog',
    notes: '## Acceptance criteria\n`node --test scripts/lib/some.test.mjs`',
    comments: ['Dispatched to workspace X at 2026-09-08T00:00:00.000Z'],
  });
});

test('BRO-3551: mapIssueToCandidate defaults priority 0 and null notes/comments safely', () => {
  const candidate = mapIssueToCandidate({ identifier: 'BRO-9002', title: null, description: null, priority: null, state: null, comments: { nodes: [] } });
  assert.equal(candidate.name, '(untitled)');
  assert.equal(candidate.priority, 0);
  assert.equal(candidate.stateType, null);
  assert.equal(candidate.notes, '');
  assert.deepEqual(candidate.comments, []);
});

test('BRO-3551: mapIssueToCandidate returns null for a malformed node (no identifier)', () => {
  assert.equal(mapIssueToCandidate({ title: 'no id' }), null);
  assert.equal(mapIssueToCandidate(null), null);
});

test('BRO-3551: end-to-end — a real Linear node flows through mapIssueToCandidate into a selected candidate', () => {
  const candidate = mapIssueToCandidate(backlogIssue());
  const out = selectOpenBacklogSweepCandidates({ issues: [candidate] });
  assert.deepEqual(out, [{ cardId: 'BRO-9001', name: 'Fix the thing', verifyCmd: 'node --test scripts/lib/some.test.mjs' }]);
});

test('BRO-3551: end-to-end — a started-type node from the wire is excluded', () => {
  const candidate = mapIssueToCandidate(backlogIssue({ stateType: 'started' }));
  const out = selectOpenBacklogSweepCandidates({ issues: [candidate] });
  assert.deepEqual(out, []);
});

// ── fetchOpenBacklogSweepCandidates (pagination + fail-loud-on-error) ───────

test('fetchOpenBacklogSweepCandidates paginates and maps issues', async () => {
  const pages = [
    { nodes: [backlogIssue({ id: 'BRO-1' })], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    { nodes: [backlogIssue({ id: 'BRO-2', stateType: 'unstarted' })], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  let i = 0;
  const result = await fetchOpenBacklogSweepCandidates({ graphql: async () => ({ issues: pages[i++] }) }, { teamKey: 'BRO' });
  assert.deepEqual(result.candidates.map(c => c.id), ['BRO-1', 'BRO-2']);
  assert.equal(result.truncated, false);
  assert.equal(result.error, null);
});

test('a fetch failure is reported via `error`, not silently swallowed into an empty result', async () => {
  const result = await fetchOpenBacklogSweepCandidates({ graphql: async () => { throw new Error('401 unauthorized (LINEAR_API_KEY not set)'); } }, { teamKey: 'BRO' });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.truncated, true);
  assert.match(result.error, /401 unauthorized/);
});

test('candidates fetched on earlier pages survive a later page failing', async () => {
  const page1 = { nodes: [backlogIssue({ id: 'BRO-1' })], pageInfo: { hasNextPage: true, endCursor: 'c1' } };
  let calls = 0;
  const result = await fetchOpenBacklogSweepCandidates({
    graphql: async () => {
      calls++;
      if (calls === 1) return { issues: page1 };
      throw new Error('network reset');
    },
  }, { teamKey: 'BRO' });
  assert.deepEqual(result.candidates.map(c => c.id), ['BRO-1']);
  assert.equal(result.truncated, true);
  assert.match(result.error, /network reset/);
});

test('reports truncated when the deadline hits mid-run', async () => {
  let now = 0;
  const result = await fetchOpenBacklogSweepCandidates(
    { graphql: async () => { throw new Error('should never be called — deadline already passed'); } },
    { teamKey: 'BRO', deadlineMs: -1, now: () => now },
  );
  assert.deepEqual(result.candidates, []);
  assert.equal(result.truncated, true);
  assert.equal(result.error, null, 'a deadline hit is truncation, not an error');
});
