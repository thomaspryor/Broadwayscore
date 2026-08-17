// Tests scripts/lib/linear-session-reporting.js's pure decision logic for
// the Linear twin of Notion's session-reporting loop (BRO-387). No live
// Linear API calls — every function under test takes plain data and returns
// a plan, per CLAUDE.md rule 15 ("extract to scripts/lib/ + require()").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  pickStateByName,
  pickStateByType,
  planClaim,
  findIssueByExactTitle,
  buildIssueIdMarker,
  extractIssueId,
  buildOutcomeCommentBody,
  planCompletion,
  hasBypass,
  evaluateSessionClose,
} = require('./linear-session-reporting.js');

const STATES = [
  { id: 'backlog-1', name: 'Backlog', type: 'backlog' },
  { id: 'todo-1', name: 'Todo', type: 'unstarted' },
  { id: 'progress-1', name: 'In Progress', type: 'started' },
  { id: 'review-1', name: 'In Review', type: 'started' },
  { id: 'done-1', name: 'Done', type: 'completed' },
  { id: 'canceled-1', name: 'Canceled', type: 'canceled' },
];

// ── pickStateByName / pickStateByType ───────────────────────────────────

test('pickStateByName: matches case-insensitively', () => {
  assert.equal(pickStateByName(STATES, 'in progress').id, 'progress-1');
  assert.equal(pickStateByName(STATES, 'IN PROGRESS').id, 'progress-1');
});

test('pickStateByName: returns null when no match', () => {
  assert.equal(pickStateByName(STATES, 'Nonexistent'), null);
});

test('pickStateByName: accepts Linear\'s {nodes:[...]} connection shape', () => {
  assert.equal(pickStateByName({ nodes: STATES }, 'Done').id, 'done-1');
});

test('pickStateByType: picks first state of the given type', () => {
  assert.equal(pickStateByType(STATES, 'backlog').id, 'backlog-1');
});

// ── planClaim ────────────────────────────────────────────────────────────

test('planClaim: no existing issue -> create, straight into In Progress', () => {
  const plan = planClaim({ issue: null, states: STATES, requestedTitle: 'New work', requestedDescription: 'desc' });
  assert.equal(plan.action, 'create');
  assert.equal(plan.title, 'New work');
  assert.equal(plan.stateName, 'In Progress');
  assert.equal(plan.stateId, 'progress-1');
});

test('planClaim: no existing issue and no title -> throws', () => {
  assert.throws(() => planClaim({ issue: null, states: STATES }), /requestedTitle/);
});

test('planClaim: issue already "In Progress" -> noop', () => {
  const issue = { id: 'issue-1', state: { name: 'In Progress', type: 'started' } };
  const plan = planClaim({ issue, states: STATES });
  assert.equal(plan.action, 'noop');
  assert.equal(plan.issueId, 'issue-1');
});

test('planClaim: issue in Todo -> activate to In Progress', () => {
  const issue = { id: 'issue-2', state: { name: 'Todo', type: 'unstarted' } };
  const plan = planClaim({ issue, states: STATES });
  assert.equal(plan.action, 'activate');
  assert.equal(plan.stateId, 'progress-1');
});

test('planClaim: issue already In Review (a DIFFERENT started-type state) -> noop, not forced back to In Progress', () => {
  // Regression guard: BRO-387 itself was found sitting in "In Review" from
  // the dispatcher's own ambiguous started-type pick (linear-next.js). A
  // session re-claiming it must NOT yank it back to "In Progress" — any
  // started-type state means someone is actively on it. Forcing a specific
  // name would fight a PRIOR session that correctly left it "In Review"
  // pending human review.
  const issue = { id: 'issue-3', state: { name: 'In Review', type: 'started' } };
  const plan = planClaim({ issue, states: STATES });
  assert.equal(plan.action, 'noop');
  assert.equal(plan.stateName, 'In Review');
});

test('planClaim: Done/Canceled issue -> activate (reopen), not refused', () => {
  const issue = { id: 'issue-4', state: { name: 'Done', type: 'completed' } };
  const plan = planClaim({ issue, states: STATES });
  assert.equal(plan.action, 'activate');
  assert.equal(plan.stateId, 'progress-1');
});

test('planClaim: falls back to type "started" when no state is literally named "In Progress"', () => {
  const renamed = STATES.map((s) => (s.name === 'In Progress' ? { ...s, name: 'Doing' } : s));
  const plan = planClaim({ issue: null, states: renamed, requestedTitle: 'x' });
  assert.equal(plan.stateName, 'Doing');
});

test('planClaim: throws when no started-type state exists at all', () => {
  const noStarted = STATES.filter((s) => s.type !== 'started');
  assert.throws(() => planClaim({ issue: null, states: noStarted, requestedTitle: 'x' }), /In Progress/);
});

// ── findIssueByExactTitle ────────────────────────────────────────────────

const OPEN_ISSUES = [
  { id: 'i1', identifier: 'BRO-1', title: 'Fix the header spacing bug' },
  { id: 'i2', identifier: 'BRO-2', title: '  Trailing whitespace title  ' },
];

test('findIssueByExactTitle: exact case-insensitive match', () => {
  assert.equal(findIssueByExactTitle(OPEN_ISSUES, 'fix the header spacing bug').id, 'i1');
});

test('findIssueByExactTitle: trims whitespace on both sides before comparing', () => {
  assert.equal(findIssueByExactTitle(OPEN_ISSUES, 'Trailing whitespace title').id, 'i2');
});

test('findIssueByExactTitle: does NOT match on substring — a real title fully containing the query', () => {
  // This is the exact case linear-client.js's searchIssues()/findOpenIssueForTerm
  // would wrongly match (substring scan); an exact matcher must not.
  assert.equal(findIssueByExactTitle(OPEN_ISSUES, 'header spacing'), null);
});

test('findIssueByExactTitle: returns null for no match or empty title', () => {
  assert.equal(findIssueByExactTitle(OPEN_ISSUES, 'nope'), null);
  assert.equal(findIssueByExactTitle(OPEN_ISSUES, ''), null);
  assert.equal(findIssueByExactTitle([], 'anything'), null);
});

// ── buildIssueIdMarker / extractIssueId ────────────────────────────────

test('buildIssueIdMarker: round-trips through extractIssueId', () => {
  const marker = buildIssueIdMarker('abc-123');
  assert.equal(extractIssueId(marker, ''), 'abc-123');
});

test('extractIssueId: marker wins even when stdout also contains unrelated UUIDs', () => {
  const combined = `session log noise\n__LINEAR_ISSUE_ID__=d1ac79d3-fe35-4c98-9e2f-3b8e82aec43f\nmore noise`;
  const stdout = 'unrelated 11111111-1111-1111-1111-111111111111 uuid';
  assert.equal(extractIssueId(combined, stdout), 'd1ac79d3-fe35-4c98-9e2f-3b8e82aec43f');
});

test('extractIssueId: falls back to JSON .id when no marker present', () => {
  const stdout = JSON.stringify({ id: 'json-id-1', identifier: 'BRO-1' });
  assert.equal(extractIssueId(stdout, stdout), 'json-id-1');
});

test('extractIssueId: falls back to a bare UUID as a last resort', () => {
  const stdout = 'created issue 22222222-2222-2222-2222-222222222222 ok';
  assert.equal(extractIssueId(stdout, stdout), '22222222-2222-2222-2222-222222222222');
});

test('extractIssueId: returns null when nothing matches', () => {
  assert.equal(extractIssueId('no id here', 'still nothing'), null);
});

// ── buildOutcomeCommentBody ──────────────────────────────────────────────

test('buildOutcomeCommentBody: requires a summary', () => {
  assert.throws(() => buildOutcomeCommentBody({ status: 'done' }), /summary/);
});

test('buildOutcomeCommentBody: includes status, summary, key files, verification', () => {
  const body = buildOutcomeCommentBody({
    summary: 'Did the thing.',
    keyFiles: ['scripts/foo.js', 'scripts/lib/bar.js'],
    verification: 'node --test scripts/foo.test.mjs',
    status: 'done',
  });
  assert.match(body, /Session report \(done\)/);
  assert.match(body, /Did the thing\./);
  assert.match(body, /scripts\/foo\.js/);
  assert.match(body, /node --test scripts\/foo\.test\.mjs/);
});

test('buildOutcomeCommentBody: omits key-files/verification sections when not given', () => {
  const body = buildOutcomeCommentBody({ summary: 'Minimal report.', status: 'blocked' });
  assert.doesNotMatch(body, /Key files/);
  assert.doesNotMatch(body, /Verification/);
});

// ── planCompletion ───────────────────────────────────────────────────────

test('planCompletion: done -> Done state', () => {
  assert.equal(planCompletion({ status: 'done', states: STATES }).stateName, 'Done');
});

test('planCompletion: in-review -> In Review state (not In Progress, despite same type)', () => {
  assert.equal(planCompletion({ status: 'in-review', states: STATES }).stateName, 'In Review');
});

test('planCompletion: paused -> Backlog state', () => {
  assert.equal(planCompletion({ status: 'paused', states: STATES }).stateName, 'Backlog');
});

test('planCompletion: blocked -> no state change (leave as-is)', () => {
  const plan = planCompletion({ status: 'blocked', states: STATES });
  assert.equal(plan.stateId, null);
  assert.equal(plan.stateName, null);
});

test('planCompletion: unknown status -> throws', () => {
  assert.throws(() => planCompletion({ status: 'yolo', states: STATES }), /unknown status/);
});

test('planCompletion: falls back to type when the named state is missing', () => {
  const noInReview = STATES.filter((s) => s.name !== 'In Review');
  // 'started' type fallback should still find "In Progress" for in-review
  const plan = planCompletion({ status: 'in-review', states: noInReview });
  assert.equal(plan.stateName, 'In Progress');
});

test('planCompletion: throws when neither the name nor the type fallback exist', () => {
  const noCompleted = STATES.filter((s) => s.type !== 'completed');
  assert.throws(() => planCompletion({ status: 'done', states: noCompleted }), /Done/);
});

// ── hasBypass / evaluateSessionClose ─────────────────────────────────────

test('hasBypass: true for a well-formed NO-LINEAR-ISSUE: line', () => {
  assert.equal(hasBypass('NO-LINEAR-ISSUE: trivial typo fix, no tracking needed'), true);
});

test('hasBypass: false for a too-short reason', () => {
  assert.equal(hasBypass('NO-LINEAR-ISSUE: no'), false);
});

test('hasBypass: false when absent', () => {
  assert.equal(hasBypass('just a normal message'), false);
});

test('evaluateSessionClose: allows when no tracked-code edits were made', () => {
  const result = evaluateSessionClose({ trackedEditsMade: false, reportedIssueId: null });
  assert.equal(result.action, 'allow');
});

test('evaluateSessionClose: allows when the session reported on an issue', () => {
  const result = evaluateSessionClose({ trackedEditsMade: true, reportedIssueId: 'issue-1' });
  assert.equal(result.action, 'allow');
});

test('evaluateSessionClose: allows via NO-LINEAR-ISSUE: bypass', () => {
  const result = evaluateSessionClose({
    trackedEditsMade: true,
    reportedIssueId: null,
    bypassText: 'NO-LINEAR-ISSUE: reverted exploration, nothing shipped',
  });
  assert.equal(result.action, 'allow');
});

test('evaluateSessionClose: BLOCKS tracked edits with no reported issue and no bypass — the refusal path', () => {
  const result = evaluateSessionClose({ trackedEditsMade: true, reportedIssueId: null, bypassText: '' });
  assert.equal(result.action, 'block');
  assert.match(result.reason, /no Linear issue was reported/);
});

test('evaluateSessionClose: a too-short bypass reason still blocks', () => {
  const result = evaluateSessionClose({ trackedEditsMade: true, reportedIssueId: null, bypassText: 'NO-LINEAR-ISSUE: no' });
  assert.equal(result.action, 'block');
});

test('evaluateSessionClose: claiming alone is NOT enough — a session that only claimed (never reported) still blocks', () => {
  // This is the exact gap flagged in the plan review: gating on "claimed"
  // instead of "reported" lets a session claim at start and vanish, so the
  // board never learns anything happened. reportedIssueId is deliberately
  // the ONLY thing checked here, not a separate claimedIssueId.
  const result = evaluateSessionClose({ trackedEditsMade: true, reportedIssueId: null, bypassText: '' });
  assert.equal(result.action, 'block');
});
