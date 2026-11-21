/**
 * autonomous-acceptance-recheck-linear.test.mjs — BRO-3373 acceptance.
 *
 * autonomous-acceptance-recheck.js only ever asked notion-brain.js for
 * Done/Paused cards. The Notion->Linear mirror froze 2026-08-20 (CLAUDE.md
 * §6), so every RECHECK-AFTER stamp posted on a Linear card since then has
 * been invisible to the nightly recheck: it exits 0 every night, looking
 * healthy, while operating on a frozen board.
 *
 * This requires the REAL functions — scripts/lib/linear-recheck-source.js's
 * mapIssueToCard (Linear GraphQL issue node -> card shape) and
 * scripts/lib/autonomous-recheck-core.js's selectRecheckTargets (the actual
 * nightly candidate-selection logic) — and feeds them a fixture shaped
 * exactly like Linear's real board: a Backlog-state issue (this team has no
 * "Paused" state; pausing a card lands it in Backlog) whose RECHECK-AFTER
 * stamp sits in a COMMENT, not the description, because that is where
 * `linear-session.js report` actually writes it at wrap-up.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mapIssueToCard, fetchLinearRecheckCandidates } = require('../lib/linear-recheck-source.js');
const { selectRecheckTargets } = require('../lib/autonomous-recheck-core.js');

// A raw GraphQL issue node, shaped exactly like buildRecheckCandidatesQuery's
// response: state.type/name, comments as {nodes:[{body,createdAt}]} (NOT a
// plain string array — mapIssueToCard is what flattens that via
// sortedCommentBodies, so the fixture must be the real wire shape).
function backlogIssue({ stampDate, id = 'BRO-9001', title = 'Fix the thing' } = {}) {
  return {
    identifier: id,
    title,
    description: '## Problem\nsome prose, no stamp here',
    updatedAt: '2026-09-10T12:00:00.000Z',
    completedAt: null,
    state: { name: 'Backlog', type: 'backlog' },
    comments: {
      nodes: [
        { body: 'Dispatched to workspace X at 2026-09-08T00:00:00.000Z', createdAt: '2026-09-08T00:00:00.000Z' },
        { body: `Paused: investigation ongoing.\n\nRECHECK-AFTER: ${stampDate}`, createdAt: '2026-09-09T00:00:00.000Z' },
      ],
    },
  };
}

const NOW = Date.parse('2026-09-15T12:00:00Z');

test('BRO-3373: a Backlog-state Linear issue with a past RECHECK-AFTER stamp in a COMMENT is selected', () => {
  const issue = backlogIssue({ stampDate: '2026-09-09' }); // in the past relative to NOW
  const card = mapIssueToCard(issue);

  // The mapping itself: Linear's "Backlog" state name is NOT rewritten to
  // "Paused" — selectRecheckTargets must not need a literal status match to
  // pick this up, only the stamp.
  assert.equal(card.id, 'BRO-9001');
  assert.equal(card.status, 'Backlog');
  assert.deepEqual(card.comments, [
    'Dispatched to workspace X at 2026-09-08T00:00:00.000Z',
    'Paused: investigation ongoing.\n\nRECHECK-AFTER: 2026-09-09',
  ]);

  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [], now: NOW });
  assert.equal(out.length, 1, 'a due, stamped Backlog card must be selected, not dropped as non-Done');
  assert.equal(out[0].cardId, 'BRO-9001');
});

test('BRO-3373: the same shape with a FUTURE RECHECK-AFTER stamp is NOT selected', () => {
  const issue = backlogIssue({ stampDate: '2026-12-01', id: 'BRO-9002' }); // in the future relative to NOW
  const card = mapIssueToCard(issue);

  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [], now: NOW });
  assert.deepEqual(out, [], 'a stamp not yet due must not be selected');
});

test('BRO-3373: a Backlog card with NO stamp at all is never swept in (only Done cards use the window fallback)', () => {
  const issue = backlogIssue({ stampDate: '2026-09-09', id: 'BRO-9003' });
  issue.comments.nodes = [issue.comments.nodes[0]]; // drop the stamped comment
  const card = mapIssueToCard(issue);

  assert.equal(card.status, 'Backlog');
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [], now: NOW });
  assert.deepEqual(out, [], 'an unstamped non-Done card must never be treated as recheckable');
});

test('BRO-3373: a completed-type Linear issue maps to status Done (window/ageDays fallback still applies)', () => {
  const issue = {
    identifier: 'BRO-9004',
    title: 'Shipped fix',
    description: 'no stamp',
    updatedAt: '2026-09-15T06:00:00.000Z',
    completedAt: '2026-09-15T06:00:00.000Z',
    state: { name: 'Done', type: 'completed' },
    comments: { nodes: [] },
  };
  const card = mapIssueToCard(issue);
  assert.equal(card.status, 'Done');
  // Sliced to the date component: doneWithinWindow treats completedDate as
  // DATE-ONLY and pads +24h to end-of-day itself — passing Linear's full ISO
  // timestamp through unchanged would silently widen the window by up to a day.
  assert.equal(card.completedDate, '2026-09-15');
});

test('BRO-3373: a RECHECK-AFTER re-stamped in a LATER comment supersedes an earlier stamp (newest wins)', () => {
  const issue = {
    identifier: 'BRO-9005',
    title: 'Re-stamped fix',
    description: 'no stamp in description',
    updatedAt: '2026-09-10T00:00:00.000Z',
    completedAt: null,
    state: { name: 'Backlog', type: 'backlog' },
    comments: {
      nodes: [
        { body: 'RECHECK-AFTER: 2026-01-01', createdAt: '2026-01-01T00:00:00.000Z' },
        { body: 'Still not ready. RECHECK-AFTER: 2026-12-25', createdAt: '2026-09-10T00:00:00.000Z' },
      ],
    },
  };
  const card = mapIssueToCard(issue);
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [], now: NOW });
  assert.deepEqual(out, [], 'the LATEST comment (2026-12-25, not yet due) must win over the stale 2026-01-01 stamp');
});

// ── fetchLinearRecheckCandidates (ship-check findings) ──────────────────────
// A ship-check review of this fix (before it shipped) caught a case where a
// missing/invalid LINEAR_API_KEY in CI would have made the whole Linear
// fetch fail silently every night, forever — indistinguishable from "nothing
// due tonight". These tests pin the fix: a real fetch failure surfaces via
// the returned `error` field (never thrown, but never silent either), and
// cards fetched on earlier pages survive a later page's failure.

test('fetchLinearRecheckCandidates paginates and maps issues', async () => {
  const pages = [
    {
      nodes: [{ identifier: 'BRO-1', title: 'A', description: '', updatedAt: null, completedAt: null, state: { name: 'Backlog', type: 'backlog' }, comments: { nodes: [] } }],
      pageInfo: { hasNextPage: true, endCursor: 'c1' },
    },
    {
      nodes: [{ identifier: 'BRO-2', title: 'B', description: '', updatedAt: null, completedAt: null, state: { name: 'Todo', type: 'unstarted' }, comments: { nodes: [] } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  ];
  let i = 0;
  const result = await fetchLinearRecheckCandidates({ graphql: async () => ({ issues: pages[i++] }) }, { teamKey: 'BRO' });
  assert.deepEqual(result.cards.map(c => c.id), ['BRO-1', 'BRO-2']);
  assert.equal(result.truncated, false);
  assert.equal(result.error, null);
});

test('THE FIX: a fetch failure is reported via `error`, not silently swallowed into an empty result', async () => {
  const result = await fetchLinearRecheckCandidates({ graphql: async () => { throw new Error('401 unauthorized (LINEAR_API_KEY not set)'); } }, { teamKey: 'BRO' });
  assert.equal(result.cards.length, 0);
  assert.equal(result.truncated, true);
  assert.match(result.error, /401 unauthorized/);
});

test('THE FIX: cards fetched on earlier pages survive a later page failing', async () => {
  const page1 = {
    nodes: [{ identifier: 'BRO-1', title: 'A', description: '', updatedAt: null, completedAt: null, state: { name: 'Backlog', type: 'backlog' }, comments: { nodes: [] } }],
    pageInfo: { hasNextPage: true, endCursor: 'c1' },
  };
  let calls = 0;
  const result = await fetchLinearRecheckCandidates({
    graphql: async () => {
      calls++;
      if (calls === 1) return { issues: page1 };
      throw new Error('network reset');
    },
  }, { teamKey: 'BRO' });
  assert.deepEqual(result.cards.map(c => c.id), ['BRO-1'], 'page 1 results must not be discarded by a page-2 failure');
  assert.equal(result.truncated, true);
  assert.match(result.error, /network reset/);
});

test('fetchLinearRecheckCandidates reports truncated when the deadline hits mid-run', async () => {
  let now = 0;
  const result = await fetchLinearRecheckCandidates(
    { graphql: async () => { throw new Error('should never be called — deadline already passed'); } },
    { teamKey: 'BRO', deadlineMs: -1, now: () => now },
  );
  assert.deepEqual(result.cards, []);
  assert.equal(result.truncated, true);
  assert.equal(result.error, null, 'a deadline hit is truncation, not an error');
});
