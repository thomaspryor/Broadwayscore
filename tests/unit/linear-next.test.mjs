// Tests scripts/lib/linear-dispatch.js's pure decision logic (seed-prompt
// construction, machine-bound routing, priority sort, GraphQL query/mutation
// builders) and scripts/linear-next.js's own pure CLI helpers — no live
// Linear API calls, no cmux, no filesystem. CLAUDE.md rule 15: these
// require() the real modules rather than re-deriving their logic here, so a
// production change to either file fails this test instead of drifting
// silently past it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAC_ONLY_LABEL,
  buildIssueQuery,
  buildOpenIssuesQuery,
  buildCommentMutation,
  priorityRank,
  priorityLabel,
  sortIssuesByPriority,
  issueLabelNames,
  hasMacOnlyLabel,
  decideRouting,
  buildLinearSeed,
  buildDispatchComment,
  generateCorrelationId,
  findUnresolvedDispatchComment,
  hasLiveLedgerEntry,
} from '../../scripts/lib/linear-dispatch.js';
import { parseArgs, ledgerTaskId } from '../../scripts/linear-next.js';

// ── GraphQL query/mutation builders ─────────────────────────────────────────

test('buildIssueQuery: parameterized on $id, fetches the fields the dispatcher needs', () => {
  const q = buildIssueQuery();
  assert.match(q, /\$id: String!/);
  assert.match(q, /issue\(id: \$id\)/);
  for (const field of ['identifier', 'title', 'description', 'priority', 'url', 'state', 'labels']) {
    assert.match(q, new RegExp(field), `query should fetch ${field}`);
  }
  // Never a raw issueCreate/api.linear.app literal — this file must stay
  // clean under audit-linear-issuecreate-chokepoint.js regardless of where
  // it's required from.
  assert.doesNotMatch(q, /issueCreate/);
});

test('buildOpenIssuesQuery: parameterized on $teamKey, excludes completed/canceled', () => {
  const q = buildOpenIssuesQuery();
  assert.match(q, /\$teamKey: String!/);
  assert.match(q, /team: \{ key: \{ eq: \$teamKey \} \}/);
  assert.match(q, /"completed", "canceled"/);
  assert.match(q, /orderBy: updatedAt/);
});

test('buildCommentMutation: parameterized on $issueId/$body, uses commentCreate', () => {
  const m = buildCommentMutation();
  assert.match(m, /\$issueId: String!/);
  assert.match(m, /\$body: String!/);
  assert.match(m, /commentCreate\(input: \{ issueId: \$issueId, body: \$body \}\)/);
});

// ── priority ────────────────────────────────────────────────────────────

test('priorityRank: Urgent(1) < High(2) < Medium(3) < Low(4) < No-priority(0)', () => {
  assert.equal(priorityRank({ priority: 1 }), 1);
  assert.equal(priorityRank({ priority: 2 }), 2);
  assert.equal(priorityRank({ priority: 3 }), 3);
  assert.equal(priorityRank({ priority: 4 }), 4);
  // The load-bearing case: raw priority 0 ("No priority") must NOT sort
  // ahead of Urgent — it is the LEAST urgent, not the most.
  assert.equal(priorityRank({ priority: 0 }), 5);
  assert.equal(priorityRank({}), 5);
  assert.equal(priorityRank({ priority: null }), 5);
});

test('priorityLabel: maps the raw int to Linear\'s own vocabulary', () => {
  assert.equal(priorityLabel({ priority: 1 }), 'Urgent');
  assert.equal(priorityLabel({ priority: 2 }), 'High');
  assert.equal(priorityLabel({ priority: 3 }), 'Medium');
  assert.equal(priorityLabel({ priority: 4 }), 'Low');
  assert.equal(priorityLabel({ priority: 0 }), 'None');
  assert.equal(priorityLabel({}), 'None');
});

test('sortIssuesByPriority: Urgent first, No-priority last, ties keep server order', () => {
  const issues = [
    { identifier: 'A', priority: 0 },
    { identifier: 'B', priority: 3 },
    { identifier: 'C', priority: 1 },
    { identifier: 'D', priority: 1 },
    { identifier: 'E', priority: 2 },
  ];
  const sorted = sortIssuesByPriority(issues).map((i) => i.identifier);
  assert.deepEqual(sorted, ['C', 'D', 'E', 'B', 'A']);
});

test('sortIssuesByPriority: does not mutate the input array', () => {
  const issues = [{ identifier: 'A', priority: 4 }, { identifier: 'B', priority: 1 }];
  const copy = [...issues];
  sortIssuesByPriority(issues);
  assert.deepEqual(issues, copy);
});

test('sortIssuesByPriority: tolerates an empty/missing list', () => {
  assert.deepEqual(sortIssuesByPriority([]), []);
  assert.deepEqual(sortIssuesByPriority(undefined), []);
});

// ── labels / machine-bound routing ─────────────────────────────────────────

test('issueLabelNames: lowercases label names, tolerates missing labels', () => {
  assert.deepEqual(
    issueLabelNames({ labels: { nodes: [{ name: 'Mac-Only' }, { name: 'P1' }] } }),
    ['mac-only', 'p1']
  );
  assert.deepEqual(issueLabelNames({}), []);
  assert.deepEqual(issueLabelNames(null), []);
});

test(`hasMacOnlyLabel: true only when the literal '${MAC_ONLY_LABEL}' label is present`, () => {
  assert.equal(hasMacOnlyLabel({ labels: { nodes: [{ name: 'mac-only' }] } }), true);
  assert.equal(hasMacOnlyLabel({ labels: { nodes: [{ name: 'Mac-Only' }] } }), true); // case-insensitive
  assert.equal(hasMacOnlyLabel({ labels: { nodes: [{ name: 'p1' }] } }), false);
  assert.equal(hasMacOnlyLabel({}), false);
});

test('decideRouting: mac-only label forces a tab even when --headless was requested', () => {
  const issue = { labels: { nodes: [{ name: 'mac-only' }] } };
  const routing = decideRouting(issue, { headless: true });
  assert.equal(routing.mode, 'tab');
  assert.match(routing.reason, /mac-only/);
});

test('decideRouting: no mac-only label defers entirely to the --headless flag', () => {
  const issue = { labels: { nodes: [] } };
  assert.equal(decideRouting(issue, { headless: true }).mode, 'headless');
  assert.equal(decideRouting(issue, { headless: false }).mode, 'tab');
  assert.equal(decideRouting(issue, {}).mode, 'tab'); // default, no opts
});

test('decideRouting: mac-only label wins regardless of other labels present', () => {
  const issue = { labels: { nodes: [{ name: 'p0' }, { name: 'mac-only' }, { name: 'infra' }] } };
  assert.equal(decideRouting(issue, { headless: true }).mode, 'tab');
});

// ── seed prompt ─────────────────────────────────────────────────────────

test('buildLinearSeed: names the issue, links it, and instructs comment + In Review transition', () => {
  const seed = buildLinearSeed({
    identifier: 'BRO-123',
    title: 'Fix the thing',
    description: 'Full description text here.',
    url: 'https://linear.app/broadway-scorecard/issue/BRO-123/fix-the-thing',
    model: 'sonnet',
    project: 'Infra',
    mode: 'tab',
  });
  assert.match(seed, /^\[BRO-123\] Fix the thing —/);
  assert.match(seed, /ISSUE: BRO-123 — Fix the thing/);
  assert.match(seed, /Linear: https:\/\/linear\.app\/broadway-scorecard\/issue\/BRO-123\/fix-the-thing/);
  assert.match(seed, /Full description text here\./);
  // The load-bearing instruction the whole task exists to encode: report back
  // ON THE ISSUE, not just in the ledger.
  assert.match(seed, /comment on this Linear issue \(BRO-123\)/);
  assert.match(seed, /"In Review"/);
  assert.match(seed, /commentCreate/);
  assert.match(seed, /issueUpdate/);
});

test('buildLinearSeed: falls back to a placeholder when description is empty', () => {
  const seed = buildLinearSeed({ identifier: 'BRO-1', title: 'T', description: '', url: '', model: 'sonnet', project: null });
  assert.match(seed, /\(no description\)/);
});

test('buildLinearSeed: omits the workspace-title line when project is null (no ref to quote)', () => {
  const seed = buildLinearSeed({ identifier: 'BRO-1', title: 'T', description: 'd', url: 'u', model: 'sonnet', project: null });
  assert.doesNotMatch(seed, /This workspace is named/);
});

test('buildLinearSeed: includes the workspace title convention when project is set', () => {
  const seed = buildLinearSeed({ identifier: 'BRO-1', title: 'T', description: 'd', url: 'u', model: 'sonnet', project: 'Data' });
  assert.match(seed, /This workspace is named/);
  assert.match(seed, /Data·/);
});

test('buildDispatchComment: reports the ref, timestamp, and mode', () => {
  const msg = buildDispatchComment({ ref: 'workspace:42', ts: '2026-08-12T12:00:00.000Z', mode: 'cmux' });
  assert.equal(msg, 'Dispatched to workspace:42 at 2026-08-12T12:00:00.000Z (cmux)');
});

test('buildDispatchComment: mode is optional', () => {
  const msg = buildDispatchComment({ ref: 'job-1a2b', ts: '2026-08-12T12:00:00.000Z' });
  assert.equal(msg, 'Dispatched to job-1a2b at 2026-08-12T12:00:00.000Z');
});

test('buildDispatchComment: embeds a correlationId when given, for cross-referencing the ledger entry', () => {
  const msg = buildDispatchComment({ ref: 'workspace:42', ts: '2026-08-12T12:00:00.000Z', mode: 'cmux', correlationId: 'ab12cd34' });
  assert.equal(msg, 'Dispatched ab12cd34 to workspace:42 at 2026-08-12T12:00:00.000Z (cmux)');
});

// ── idempotency (plan review item 4) ────────────────────────────────────────

test('generateCorrelationId: returns a short opaque hex string, different each call', () => {
  const a = generateCorrelationId();
  const b = generateCorrelationId();
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test('findUnresolvedDispatchComment: finds the most recent "Dispatched ..." comment on an open issue', () => {
  const issue = {
    state: { type: 'started' },
    comments: { nodes: [
      { body: 'unrelated comment', createdAt: 't0' },
      { body: 'Dispatched ab12 to workspace:1 at t1 (cmux)', createdAt: 't1' },
      { body: 'Dispatched cd34 to workspace:2 at t2 (cmux)', createdAt: 't2' },
    ] },
  };
  const found = findUnresolvedDispatchComment(issue);
  assert.equal(found.createdAt, 't2'); // most recent wins
});

test('findUnresolvedDispatchComment: null when no Dispatched comment exists', () => {
  const issue = { state: { type: 'unstarted' }, comments: { nodes: [{ body: 'just a note' }] } };
  assert.equal(findUnresolvedDispatchComment(issue), null);
});

test('findUnresolvedDispatchComment: null once the issue itself is completed/canceled — a stale comment on a closed issue is not live', () => {
  const dispatched = { body: 'Dispatched ab12 to workspace:1 at t1 (cmux)' };
  assert.equal(findUnresolvedDispatchComment({ state: { type: 'completed' }, comments: { nodes: [dispatched] } }), null);
  assert.equal(findUnresolvedDispatchComment({ state: { type: 'canceled' }, comments: { nodes: [dispatched] } }), null);
});

test('findUnresolvedDispatchComment: tolerates missing state/comments', () => {
  assert.equal(findUnresolvedDispatchComment({}), null);
  assert.equal(findUnresolvedDispatchComment(null), null);
});

test('hasLiveLedgerEntry: true for a verified cmux launch with no later terminal entry', () => {
  const entries = [{ event: 'launch', taskId: 'linear:BRO-1', workspaceRef: 'workspace:9', ts: '2026-08-12T10:00:00.000Z' }];
  assert.equal(hasLiveLedgerEntry('linear:BRO-1', entries), true);
});

test('hasLiveLedgerEntry: false when no attempt has ever been recorded for this task', () => {
  assert.equal(hasLiveLedgerEntry('linear:BRO-999', []), false);
});

test('hasLiveLedgerEntry: false when the latest attempt is dead/unverified', () => {
  const entries = [
    { event: 'dead', taskId: 'linear:BRO-2', workspaceRef: 'workspace:5', ts: '2026-08-12T10:00:00.000Z' },
    { event: 'launch', taskId: 'linear:BRO-2', workspaceRef: 'workspace:5', ts: '2026-08-12T10:00:00.001Z', unverified: true },
  ];
  assert.equal(hasLiveLedgerEntry('linear:BRO-2', entries), false);
});

test('hasLiveLedgerEntry: false once a headless job finished (JOB_EVENTS.DONE is terminal, not live)', () => {
  const entries = [
    { event: 'job-spawned', taskId: 'linear:BRO-3', jobId: 'j1', ts: '2026-08-12T10:00:00.000Z' },
    { event: 'job-done', taskId: 'linear:BRO-3', jobId: 'j1', ts: '2026-08-12T10:05:00.000Z' },
  ];
  assert.equal(hasLiveLedgerEntry('linear:BRO-3', entries), false);
});

test('hasLiveLedgerEntry: ignores entries for other tasks', () => {
  const entries = [{ event: 'launch', taskId: 'linear:BRO-OTHER', workspaceRef: 'workspace:1', ts: '2026-08-12T10:00:00.000Z' }];
  assert.equal(hasLiveLedgerEntry('linear:BRO-4', entries), false);
});

// ── scripts/linear-next.js's own pure helpers ───────────────────────────────

test('ledgerTaskId: namespaces Linear dispatches distinctly from bare numeric Notion task ids', () => {
  assert.equal(ledgerTaskId('BRO-123'), 'linear:BRO-123');
  assert.notEqual(ledgerTaskId('123'), '123');
});

test('parseArgs: --id value, boolean flags, positional args', () => {
  const a = parseArgs(['--id', 'BRO-123', '--headless', '--model', 'opus', 'extra']);
  assert.equal(a.id, 'BRO-123');
  assert.equal(a.headless, true);
  assert.equal(a.model, 'opus');
  assert.deepEqual(a._, ['extra']);
});

test('parseArgs: a flag immediately followed by another flag is boolean, not a value-eater', () => {
  const a = parseArgs(['--dry-run', '--id', 'BRO-1']);
  assert.equal(a['dry-run'], true);
  assert.equal(a.id, 'BRO-1');
});
