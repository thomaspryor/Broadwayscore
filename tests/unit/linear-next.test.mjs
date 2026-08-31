// Tests scripts/lib/linear-dispatch.js's pure decision logic (seed-prompt
// construction, machine-bound routing, priority sort, GraphQL query/mutation
// builders) and scripts/linear-next.js's own pure CLI helpers — no live
// Linear API calls, no cmux, no filesystem. CLAUDE.md rule 15: these
// require() the real modules rather than re-deriving their logic here, so a
// production change to either file fails this test instead of drifting
// silently past it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MAC_ONLY_LABEL,
  buildIssueQuery,
  buildOpenIssuesQuery,
  buildOpenIssuesWithDescriptionsQuery,
  findOpenIssueForTerm,
  buildCommentMutation,
  priorityRank,
  priorityLabel,
  sortIssuesByPriority,
  issueLabelNames,
  hasMacOnlyLabel,
  decideRouting,
  checkTerminalStateGuard,
  buildLinearSeed,
  buildDispatchComment,
  generateCorrelationId,
  findUnresolvedDispatchComment,
  hasLiveLedgerEntry,
} from '../../scripts/lib/linear-dispatch.js';
import { parseArgs, ledgerTaskId, main, reportDispatchOnIssue } from '../../scripts/linear-next.js';

// REPO root for the subprocess regression test below — spawned from a fixed
// cwd so scripts/linear-next.js's own require('./bsc-next.js') etc. resolve
// normally, same as running the CLI for real.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// A no-op Linear client for any main() test whose launch path reaches
// reportDispatchOnIssue() — without this, main()'s default `deps.linear`
// falls through to the REAL scripts/lib/linear-client.js, and a successful
// dispatch (e.g. --force reaching a stubbed launchCmux) makes a genuine
// network call to the live Linear workspace (BRO-287: caught live — a test
// here was silently calling real getTeam/getIssue/createComment/updateIssue
// against a real issue whenever LINEAR_API_KEY happened to be set, violating
// this file's own "no live Linear API calls" invariant stated above).
function noopLinearDeps() {
  return {
    linear: {
      createComment: async () => {},
      getTeam: async () => ({ states: [] }),
      getIssue: async () => null,
      updateIssue: async () => {},
      TEAM_KEY: 'BRO',
    },
  };
}

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

test('buildOpenIssuesQuery: parameterized on $teamKey, excludes completed/canceled/duplicate, cursor-paginated', () => {
  const q = buildOpenIssuesQuery();
  assert.match(q, /\$teamKey: String!/);
  assert.match(q, /team: \{ key: \{ eq: \$teamKey \} \}/);
  assert.match(q, /"completed","canceled","duplicate"/);
  assert.match(q, /orderBy: updatedAt/);
  // 200+ issue workspace: a single first:100 page silently truncates — the
  // query must expose the cursor machinery linear-client.js's loop consumes.
  assert.match(q, /\$after: String/);
  assert.match(q, /after: \$after/);
  assert.match(q, /pageInfo \{ hasNextPage endCursor \}/);
});

test('buildCommentMutation: parameterized on $issueId/$body, uses commentCreate', () => {
  const m = buildCommentMutation();
  assert.match(m, /\$issueId: String!/);
  assert.match(m, /\$body: String!/);
  assert.match(m, /commentCreate\(input: \{ issueId: \$issueId, body: \$body \}\)/);
});

// ── Rail 2 (Phase 0 parallel-run safety, plan 2026-08-12, task #1341) ──────

test('buildOpenIssuesWithDescriptionsQuery: parameterized on $teamKey, excludes completed/canceled/duplicate, fetches description, cursor-paginated', () => {
  const q = buildOpenIssuesWithDescriptionsQuery();
  assert.match(q, /\$teamKey: String!/);
  assert.match(q, /team: \{ key: \{ eq: \$teamKey \} \}/);
  assert.match(q, /"completed","canceled","duplicate"/);
  assert.match(q, /description/);
  // Dedupe must see EVERY open issue: missing a page-2 match means filing the
  // exact duplicate tracker rail 2 exists to prevent.
  assert.match(q, /\$after: String/);
  assert.match(q, /after: \$after/);
  assert.match(q, /pageInfo \{ hasNextPage endCursor \}/);
  // Never a raw issueCreate/api.linear.app literal — same chokepoint rule
  // as buildIssueQuery's test above.
  assert.doesNotMatch(q, /issueCreate/);
});

test('findOpenIssueForTerm: matches on title', () => {
  const issues = [{ identifier: 'BRO-1', title: 'Cookies expiration alert', description: '' }];
  const match = findOpenIssueForTerm(issues, 'Cookies expiration');
  assert.equal(match.identifier, 'BRO-1');
});

test('findOpenIssueForTerm: matches on description (e.g. the conditionKey embedded in a filed card body)', () => {
  const issues = [{ identifier: 'BRO-2', title: 'Some other title', description: 'blah blah [conditionKey:health-check:Cookies: expiration] blah' }];
  const match = findOpenIssueForTerm(issues, 'health-check:Cookies: expiration');
  assert.equal(match.identifier, 'BRO-2');
});

test('findOpenIssueForTerm: null when no issue matches', () => {
  const issues = [{ identifier: 'BRO-3', title: 'Unrelated', description: 'nothing here' }];
  assert.equal(findOpenIssueForTerm(issues, 'health-check:Cookies: expiration'), null);
});

test('findOpenIssueForTerm: first match wins over a later one', () => {
  const issues = [
    { identifier: 'BRO-4', title: 'x', description: '[conditionKey:test:dup]' },
    { identifier: 'BRO-5', title: 'x', description: '[conditionKey:test:dup]' },
  ];
  assert.equal(findOpenIssueForTerm(issues, 'test:dup').identifier, 'BRO-4');
});

test('findOpenIssueForTerm: tolerates null/missing fields and an empty term/issues list', () => {
  assert.equal(findOpenIssueForTerm([null, { identifier: 'BRO-6' }], 'x'), null);
  assert.equal(findOpenIssueForTerm([], 'x'), null);
  assert.equal(findOpenIssueForTerm(null, 'x'), null);
  assert.equal(findOpenIssueForTerm([{ identifier: 'BRO-7', title: 'x' }], ''), null);
  assert.equal(findOpenIssueForTerm([{ identifier: 'BRO-7', title: 'x' }], null), null);
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

// ── terminal-state guard (task #1517, BRO-247 incident root cause) ─────────

test('checkTerminalStateGuard: refuses a completed issue, names the state', () => {
  const issue = { identifier: 'BRO-247', state: { type: 'completed', name: 'Done' } };
  const refusal = checkTerminalStateGuard(issue);
  assert.match(refusal, /BRO-247/);
  assert.match(refusal, /"Done"/);
  assert.match(refusal, /--force/);
});

test('checkTerminalStateGuard: refuses a canceled issue', () => {
  const issue = { identifier: 'BRO-9', state: { type: 'canceled', name: 'Canceled' } };
  assert.match(checkTerminalStateGuard(issue), /BRO-9/);
});

test('checkTerminalStateGuard: refuses a duplicate issue (BRO-2466 — the third terminal type)', () => {
  const issue = { identifier: 'BRO-2400', state: { type: 'duplicate', name: 'Duplicate' } };
  assert.match(checkTerminalStateGuard(issue), /BRO-2400/);
});

test('checkTerminalStateGuard: null (proceed) for any non-terminal state', () => {
  assert.equal(checkTerminalStateGuard({ identifier: 'BRO-1', state: { type: 'unstarted', name: 'Todo' } }), null);
  assert.equal(checkTerminalStateGuard({ identifier: 'BRO-1', state: { type: 'started', name: 'In Progress' } }), null);
  assert.equal(checkTerminalStateGuard({ identifier: 'BRO-1', state: { type: 'backlog', name: 'Backlog' } }), null);
});

test('checkTerminalStateGuard: tolerates missing state', () => {
  assert.equal(checkTerminalStateGuard({ identifier: 'BRO-1' }), null);
  assert.equal(checkTerminalStateGuard({ identifier: 'BRO-1', state: null }), null);
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
  //
  // BRO-2543 changed HOW: the seed used to say "commentCreate ... issueUpdate",
  // i.e. hand-roll the GraphQL call. That produced outcome comments in whatever
  // prose the worker chose, so the canonical `**Session report (<status>)**`
  // header existed only when the machine-local linear-issue-required-stop.sh
  // Stop hook happened to force linear-session.js — never on a cloud session,
  // and never for a worker killed at its runner timeout. reportedOutcomeGuard
  // has to RECOGNISE these comments to stop a duplicate dispatch, so the seed
  // now names the canonical reporter. Pinned here because a well-meaning
  // rewrite back to "just post a comment" would silently re-open BRO-2506's
  // wasted-dispatch hole with every test still green.
  assert.match(seed, /node scripts\/linear-session\.js report --issue=BRO-123/);
  assert.match(seed, /--status=<done\|in-review\|paused\|blocked>/);
  // --status=blocked must stay described as leaving the state alone: that is
  // what keeps a genuinely stalled issue re-dispatchable (reportedOutcomeGuard
  // deliberately ignores blocked/paused reports).
  assert.match(seed, /--status=blocked/);
  assert.match(seed, /"In Review"/);
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

// ── guard-parity regression (ship-check P1) ─────────────────────────────────
//
// bsc-next.js's own --headless branch runs the findLiveWorkspaceForTask
// duplicate-tab check ON PURPOSE (see its comment at the top of the
// --headless block): bsc-runner's cross-dispatcher lease is keyed by taskId
// ONLY, so it only ever sees OTHER headless jobs — it has no visibility into
// a live cmux TAB already open on the same task. A prior version of
// linear-next.js's main() skipped this exact check for `routing.mode ===
// 'headless'`, which is the inverse of the reason the check exists.
//
// This drives main() end-to-end IN A REAL SUBPROCESS, not an in-process call
// with process.exit stubbed to throw: the guard's own `try { ... } catch (e)
// { console.error('...continuing...') }` wraps the process.exit(1) call, so a
// throwing stub is swallowed by that SAME catch (bsc-next-ci-red-claim.test.mjs
// documents this exact unobservability for bsc-next.js's identical guard
// shape, which is why that suite uses structural source assertions instead).
// A real child process lets process.exit(1) actually terminate — genuine
// behavioral proof, not a structural stand-in.
test('guard parity: --headless dispatch is refused (real process exit) when a live cmux tab already matches the issue', () => {
  const script = `
    const { main } = require('./scripts/linear-next.js');
    const issue = {
      id: 'issue-uuid-guard-parity', identifier: 'BRO-9001',
      title: 'Guard parity regression fixture issue',
      description: '## Acceptance criteria\\n\`node --test tests/unit/some-fixture.test.mjs\`',
      url: 'https://linear.app/broadway-scorecard/issue/BRO-9001/guard-parity-regression-fixture-issue',
      priority: 2,
      state: { id: 'todo-1', name: 'Todo', type: 'unstarted' },
      labels: { nodes: [] }, comments: { nodes: [] },
    };
    // findLiveWorkspaceForTask/titleMatchesSubject matches on the launch
    // title (task.subject = "<identifier> <title>"), so the fixture
    // workspace's title is exactly that string — a real live-title match.
    const subject = issue.identifier + ' ' + issue.title;
    const liveWorkspace = { ref: 'workspace:77', title: subject };
    main(['--id', issue.identifier, '--headless'], {
      getIssue: async () => issue,
      launchCmux: () => { throw new Error('launchCmux must not be called — refusal happens before any launch attempt'); },
      runJobFn: async () => { console.error('RUNJOB_WAS_CALLED'); return { ok: true, jobId: 'j1', logFile: null }; },
      cmuxAvailable: () => true,
      listWorkspaces: () => [liveWorkspace],
      isDoneTitle: () => false,
      // workspace reads as LIVE — checkDeadDispatch must not self-heal it
      // into a 'dead' breadcrumb before the duplicate-tab check even runs.
      claudeAliveIn: () => true,
      terminalSurfaceAliveIn: () => true,
      readLedgerEntries: () => [],
      appendLedgerEntry: () => {},
      // task #1696's overlap check — no live Linear API call, no real
      // ~/.claude/tasks read, from a test subprocess.
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
      // task #1898's fresh-dispatch claim runs before the overlap check /
      // duplicate-tab guard this test exercises — stub it so this subprocess
      // never touches the real data/audit/linear-dispatch-claims dir.
      acquireDispatchClaim: () => true,
      releaseDispatchClaim: () => {},
      // BRO-278's work-branch collision check also runs before the
      // duplicate-tab guard this test exercises — stub it so this subprocess
      // never shells out to real git (fetch/branch/cherry) against this repo.
      listWorkBranchStatuses: () => [],
    });
  `;
  const res = spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
  assert.equal(res.status, 1, `expected exit 1 (duplicate-tab refusal), got ${res.status}. stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stderr, /a live workspace already matches/, 'must report the duplicate-tab refusal, not some other gate');
  assert.doesNotMatch(res.stderr, /RUNJOB_WAS_CALLED/, 'runJob must NEVER be called once the duplicate-tab guard refuses — this is the regression the guard-parity fix closes');
});

// -- reportedOutcomeGuard wiring, BRO-2543 -----------------------------------
//
// This is a WIRING test on purpose, and it is the only kind that can catch
// this ticket's own bug class. A pure-predicate test of reportedOutcomeGuard
// passes identically whether linear-next.js calls it as
// `ld.reportedOutcomeGuard(issue, args)` or hides it behind
// `if (!args.force) { ... }` — and "the guard exists but can never fire" is
// literally BRO-2488's root cause (no query ever fetched `project`, so no
// predicate keyed on it could refuse anything). So: drive the real main()
// in a real subprocess with the real 02:15:05Z payload and the real
// --force, and assert nothing launches.
test('reportedOutcomeGuard wiring: --force does NOT dispatch an issue whose outstanding dispatch already reported in-review (BRO-2506 incident)', () => {
  const script = `
    const { main } = require('./scripts/linear-next.js');
    // BRO-2506 exactly as it stood at 02:15:05Z: In Review, the 00:43
    // dispatch comment, the 01:31 session report. Comments newest-first,
    // the order Linear's API really returns them in.
    const issue = {
      id: 'issue-uuid-2506', identifier: 'BRO-9506',
      title: 'Reported-outcome guard regression fixture issue',
      description: '## Acceptance criteria\\n\`node --test tests/unit/some-fixture.test.mjs\`',
      url: 'https://linear.app/broadway-scorecard/issue/BRO-9506/reported-outcome-guard-regression-fixture-issue',
      priority: 2,
      state: { id: 'in-review-1', name: 'In Review', type: 'started' },
      labels: { nodes: [] },
      comments: { nodes: [
        { body: '**Session report (in-review)**\\n\\nFix landed on origin/main.', createdAt: '2026-08-31T01:31:24.775Z' },
        { body: 'Dispatched 0e0f245d to workspace:138 at 2026-08-31T00:43:00.598Z (cmux)', createdAt: '2026-08-31T00:43:00.704Z' },
      ] },
    };
    main(['--id', issue.identifier, '--model', 'opus', '--force'], {
      getIssue: async () => issue,
      launchCmux: () => { console.error('LAUNCHCMUX_WAS_CALLED'); return { ok: true, ref: 'workspace:36' }; },
      runJobFn: async () => { console.error('RUNJOB_WAS_CALLED'); return { ok: true, jobId: 'j1', logFile: null }; },
      cmuxAvailable: () => true,
      listWorkspaces: () => [],
      isDoneTitle: () => false,
      claudeAliveIn: () => true,
      terminalSurfaceAliveIn: () => true,
      readLedgerEntries: () => [],
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
      acquireDispatchClaim: () => true,
      releaseDispatchClaim: () => {},
      listWorkBranchStatuses: () => [],
    });
  `;
  const res = spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
  assert.equal(res.status, 1, `expected exit 1 (reported-outcome refusal), got ${res.status}. stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stderr, /ALREADY reported back/, 'must report the reported-outcome refusal, not some other gate');
  assert.match(res.stderr, /session report \(in-review\)/);
  // The regression that matters: --force must not reach a launch.
  assert.doesNotMatch(res.stderr, /LAUNCHCMUX_WAS_CALLED/, 'launchCmux must NEVER be called — this is BRO-2506 recurring');
  assert.doesNotMatch(res.stderr, /RUNJOB_WAS_CALLED/, 'runJob must NEVER be called — this is BRO-2506 recurring');
});

test('reportedOutcomeGuard wiring: it refuses BEFORE startedStateGuard, so the message never says "re-run with --force"', () => {
  // Ordering matters for behaviour, not just prose: startedStateGuard's own
  // remedy line is "Re-run with --force if you know this is a stalled issue
  // that needs re-dispatch" — which, on THIS issue, is the exact instruction
  // that wasted a dispatch. On a no-flag run both guards match, so whichever
  // runs first owns the operator's next action.
  const script = `
    const { main } = require('./scripts/linear-next.js');
    const issue = {
      id: 'issue-uuid-2506b', identifier: 'BRO-9507',
      title: 'Reported-outcome ordering fixture issue',
      description: '## Acceptance criteria\\n\`node --test tests/unit/some-fixture.test.mjs\`',
      url: 'https://linear.app/broadway-scorecard/issue/BRO-9507/reported-outcome-ordering-fixture-issue',
      priority: 2,
      state: { id: 'in-review-1', name: 'In Review', type: 'started' },
      labels: { nodes: [] },
      comments: { nodes: [
        { body: '**Session report (done)**\\n\\nAll finished.', createdAt: '2026-08-31T01:31:24.775Z' },
        { body: 'Dispatched 0e0f245d to workspace:138 at 2026-08-31T00:43:00.598Z (cmux)', createdAt: '2026-08-31T00:43:00.704Z' },
      ] },
    };
    main(['--id', issue.identifier], {
      getIssue: async () => issue,
      launchCmux: () => { console.error('LAUNCHCMUX_WAS_CALLED'); return { ok: true, ref: 'workspace:36' }; },
      cmuxAvailable: () => true,
      listWorkspaces: () => [], isDoneTitle: () => false,
      claudeAliveIn: () => true, terminalSurfaceAliveIn: () => true,
      readLedgerEntries: () => [], appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [], loadNotionMirrorTasks: () => [],
      acquireDispatchClaim: () => true, releaseDispatchClaim: () => {},
      listWorkBranchStatuses: () => [],
    });
  `;
  const res = spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /ALREADY reported back/, 'reportedOutcomeGuard must win the race with startedStateGuard');
  assert.doesNotMatch(res.stderr, /is already in a started state/, 'startedStateGuard must not be the message the operator reads here');
});

test('reportedOutcomeGuard wiring: --allow-reported-work "<reason>" lets a genuine re-dispatch through', () => {
  // The escape hatch has to actually work end-to-end, or an operator facing a
  // truly-stalled issue is wedged. Proven by reaching a LATER gate (the
  // kill switch) rather than this one.
  //
  // Both flags, because these are two independent guards: --force clears
  // startedStateGuard ("something has hands on this"), --allow-reported-work
  // clears this one ("...and it already reported back"). This pair IS the
  // documented recovery command, and the refusal text names it verbatim —
  // asserted below so the message can never drift out of sync with what
  // actually works.
  const script = `
    process.env.LINEAR_NEXT_DISABLED = '1';
    const { main } = require('./scripts/linear-next.js');
    const issue = {
      id: 'issue-uuid-2506c', identifier: 'BRO-9508',
      title: 'Reported-outcome bypass fixture issue',
      description: '## Acceptance criteria\\n\`node --test tests/unit/some-fixture.test.mjs\`',
      url: 'https://linear.app/broadway-scorecard/issue/BRO-9508/reported-outcome-bypass-fixture-issue',
      priority: 2,
      state: { id: 'in-review-1', name: 'In Review', type: 'started' },
      labels: { nodes: [] },
      comments: { nodes: [
        { body: '**Session report (in-review)**\\n\\nClaimed done but never landed.', createdAt: '2026-08-31T01:31:24.775Z' },
        { body: 'Dispatched 0e0f245d to workspace:138 at 2026-08-31T00:43:00.598Z (cmux)', createdAt: '2026-08-31T00:43:00.704Z' },
      ] },
    };
    main(['--id', issue.identifier, '--force', '--allow-reported-work', 'checked main, the commit is not there'], {
      getIssue: async () => issue,
      launchCmux: () => { console.error('LAUNCHCMUX_WAS_CALLED'); return { ok: true, ref: 'workspace:36' }; },
      cmuxAvailable: () => true,
      listWorkspaces: () => [], isDoneTitle: () => false,
      claudeAliveIn: () => true, terminalSurfaceAliveIn: () => true,
      readLedgerEntries: () => [], appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [], loadNotionMirrorTasks: () => [],
      acquireDispatchClaim: () => true, releaseDispatchClaim: () => {},
      listWorkBranchStatuses: () => [],
    });
  `;
  const res = spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
  assert.doesNotMatch(res.stderr, /ALREADY reported back/, 'a reasoned bypass must clear reportedOutcomeGuard');
  assert.match(res.stderr, /LINEAR_NEXT_DISABLED/, 'should reach the later kill-switch gate, proving it got past this guard');
});

test('parseArgs: --flag=value form is honoured, and --force=0/false/"" cannot bypass anything (BRO-2576)', () => {
  // BRO-2543 first "fixed" the `--k=v` form in passing and the pre-ship
  // adversarial review caught that it made things WORSE: naively splitting on
  // `=` turns `--force=0` into the truthy string "0", so a flag an operator
  // wrote expressly to DISABLE forcing would instead bypass every guard
  // --force gates. Reverted there. BRO-2576 fixes it properly by deciding the
  // `=0`/`=false`/`=` "off" semantics up front (coerceFlagValue) before ever
  // splitting on `=`, so `--model=opus` works AND `--force=0` stays inert.
  const a = parseArgs(['--force=0']);
  assert.equal(a.force, false, '--force=0 must coerce to false, not the truthy string "0"');
  assert.equal(a['force=0'], undefined);

  const a2 = parseArgs(['--force=false']);
  assert.equal(a2.force, false);

  const a3 = parseArgs(['--force=']);
  assert.equal(a3.force, false, 'a bare trailing = is also "off", not the truthy empty string');

  // Every guard in linear-next.js reads args.force via truthiness
  // (`!args.force`, `args.force || ...`), so `false` behaves exactly like
  // "flag never passed" — no guard needs to know about the `=` form.
  assert.ok(!a.force && !a2.force && !a3.force);

  // The space form still works, unchanged.
  const b = parseArgs(['--id', 'BRO-1', '--force', '--allow-reported-work', 'checked main, not there']);
  assert.equal(b.id, 'BRO-1');
  assert.equal(b.force, true);
  assert.equal(b['allow-reported-work'], 'checked main, not there');

  // And the `=` form now genuinely carries a value-flag's payload.
  const c = parseArgs(['--allow-reported-work=some reason here', '--id=BRO-1', '--model=opus']);
  assert.equal(c['allow-reported-work'], 'some reason here');
  assert.equal(c.id, 'BRO-1');
  assert.equal(c.model, 'opus');

  // Only the first `=` splits the key from the value.
  assert.equal(parseArgs(['--note=a=b']).note, 'a=b');
});

// ── mirror-staleness dispatch claim, task #1898 (parity with bsc-next.js's
// task #1896 claim wiring tests, scripts/bsc-next.test.mjs:1400-1478) ───────
//
// A non-terminal issue with LINEAR_NEXT_DISABLED unset reaches the claim
// (placed after the terminal-state guard + kill switch, before the overlap
// check — see linear-next.js's claim block comment for why).
function makeClaimTestIssue() {
  return {
    id: 'issue-uuid-1898', identifier: 'BRO-1898', title: 'Some claimable issue',
    description: '## Acceptance criteria\n`node --test tests/unit/some-fixture.test.mjs`',
    url: 'https://linear.app/broadway-scorecard/issue/BRO-1898/some-claimable-issue',
    priority: 2,
    state: { id: 'state-1', name: 'Todo', type: 'unstarted' },
    labels: { nodes: [] }, comments: { nodes: [] },
  };
}

test('main(): a held dispatch claim refuses BEFORE the overlap check ever runs', async () => {
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => { exitCode = code; throw new Error('EXIT'); };
  const origError = console.error;
  const errors = [];
  console.error = (msg) => errors.push(String(msg));
  try {
    await assert.rejects(() => main(['--id', 'BRO-1898'], {
      getIssue: async () => makeClaimTestIssue(),
      acquireDispatchClaim: () => false, // "another attempt already holds it"
      releaseDispatchClaim: () => {},
      listOpenIssuesWithDescriptions: async () => { throw new Error('overlap check must never run once the claim guard refuses'); },
      loadNotionMirrorTasks: () => { throw new Error('overlap check must never run once the claim guard refuses'); },
      launchCmux: () => { throw new Error('launchCmux must never be called once the claim guard refuses'); },
      appendLedgerEntry: () => { throw new Error('appendLedgerEntry must not be called once the claim guard refuses'); },
    }), /EXIT/);
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
  assert.equal(exitCode, 1);
  assert.ok(errors.some(e => /REFUSING to dispatch #BRO-1898/.test(e) && /mirror-staleness race/.test(e)),
    `expected a mirror-staleness claim refusal keyed on the bare identifier, got: ${errors.join(' | ')}`);
});

test('main(): --force bypasses the dispatch claim entirely (acquireDispatchClaim never even called)', async () => {
  const origError = console.error;
  console.error = () => {};
  let claimCalled = false;
  let launched = false;
  try {
    await main(['--id', 'BRO-1898', '--force'], {
      getIssue: async () => makeClaimTestIssue(),
      acquireDispatchClaim: () => { claimCalled = true; return false; },
      releaseDispatchClaim: () => {},
      launchCmux: () => { launched = true; return { ok: true, ref: 'workspace:1', adoptedLate: false }; },
      cmuxAvailable: () => false,
      readLedgerEntries: () => [],
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
      ...noopLinearDeps(),
    });
  } finally {
    console.error = origError;
  }
  assert.equal(claimCalled, false, '--force must skip claim acquisition entirely, matching every sibling guard\'s carve-out');
  assert.equal(launched, true);
});

test('main(): --dry-run bypasses the dispatch claim entirely (no side-effecting claim I/O during a preview)', async () => {
  const origLog = console.log;
  const logs = [];
  console.log = (msg) => logs.push(String(msg));
  let claimCalled = false;
  try {
    await main(['--id', 'BRO-1898', '--dry-run'], {
      getIssue: async () => makeClaimTestIssue(),
      acquireDispatchClaim: () => { claimCalled = true; return true; },
      releaseDispatchClaim: () => {},
      appendLedgerEntry: () => { throw new Error('appendLedgerEntry must never be called on a --dry-run preview'); },
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    });
  } finally {
    console.log = origLog;
  }
  assert.equal(claimCalled, false, '--dry-run must never acquire a real claim');
  assert.ok(logs.some(l => /would launch/.test(l)));
});

// ── terminal-state dispatch guard, end-to-end (task #1517) ─────────────────
//
// Drives main() in-process (no live process.exit path is hit before the
// guard fires — it's the very first check after "issue not found", ahead of
// dry-run/kill-switch/verify-gate/idempotency), so a stubbed getIssue is
// enough; no subprocess needed here (unlike the guard-parity test above,
// which exercises a later guard whose own try/catch would swallow a thrown
// process.exit stub).

function makeTerminalIssue(stateType, stateName) {
  return {
    id: 'issue-uuid-1517', identifier: 'BRO-1517', title: 'Some terminal issue',
    description: '## Acceptance criteria\n`node --test tests/unit/some-fixture.test.mjs`',
    url: 'https://linear.app/broadway-scorecard/issue/BRO-1517/some-terminal-issue',
    priority: 2,
    state: { id: 'state-1', name: stateName, type: stateType },
    labels: { nodes: [] }, comments: { nodes: [] },
  };
}

test('main(): refuses to dispatch a completed issue', async () => {
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => { exitCode = code; throw new Error('EXIT'); };
  const origError = console.error;
  const errors = [];
  console.error = (msg) => errors.push(msg);
  try {
    await assert.rejects(() => main(['--id', 'BRO-1517'], {
      getIssue: async () => makeTerminalIssue('completed', 'Done'),
      launchCmux: () => { throw new Error('launchCmux must not be called'); },
      appendLedgerEntry: () => { throw new Error('appendLedgerEntry must not be called for a terminal issue'); },
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    }), /EXIT/);
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
  assert.equal(exitCode, 1);
  assert.match(errors.join('\n'), /already in a terminal state \("Done"\)/);
});

test('main(): refuses to dispatch a canceled issue', async () => {
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => { exitCode = code; throw new Error('EXIT'); };
  const origError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(() => main(['--id', 'BRO-1517'], {
      getIssue: async () => makeTerminalIssue('canceled', 'Canceled'),
      launchCmux: () => { throw new Error('launchCmux must not be called'); },
      appendLedgerEntry: () => { throw new Error('appendLedgerEntry must not be called for a terminal issue'); },
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    }), /EXIT/);
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
  assert.equal(exitCode, 1);
});

test('main(): --force overrides the terminal-state refusal and proceeds to launch', async () => {
  const origError = console.error;
  console.error = () => {};
  let launched = false;
  try {
    await main(['--id', 'BRO-1517', '--force'], {
      getIssue: async () => makeTerminalIssue('completed', 'Done'),
      launchCmux: () => { launched = true; return { ok: true, ref: 'workspace:1', adoptedLate: false }; },
      cmuxAvailable: () => false,
      readLedgerEntries: () => [],
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
      ...noopLinearDeps(),
    });
  } finally {
    console.error = origError;
  }
  assert.equal(launched, true);
});

test('main(): a non-terminal issue is unaffected by the guard (dry-run reaches the seed print)', async () => {
  const origLog = console.log;
  const logs = [];
  console.log = (msg) => logs.push(msg);
  try {
    await main(['--id', 'BRO-1517', '--dry-run'], {
      getIssue: async () => makeTerminalIssue('unstarted', 'Todo'),
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    });
  } finally {
    console.log = origLog;
  }
  assert.match(logs.join('\n'), /would launch/);
});

// ── marketing-project dispatch guard, end-to-end (BRO-2488) ────────────────
// BRO-128 (Linear project "Marketing/distribution") dispatched cleanly
// through this exact main() with no refusal, because issue.project was never
// fetched. These drive main() the same way the terminal-state tests above
// do, proving the wired-in guard actually blocks a live --id dispatch.
function makeMarketingIssue(projectName = 'Marketing/distribution') {
  return {
    id: 'issue-uuid-2488', identifier: 'BRO-2488', title: 'Some marketing issue',
    description: '## Acceptance criteria\n`node --test tests/unit/some-fixture.test.mjs`',
    url: 'https://linear.app/broadway-scorecard/issue/BRO-2488/some-marketing-issue',
    priority: 2,
    state: { id: 'state-1', name: 'Backlog', type: 'backlog' },
    project: { id: 'proj-1', name: projectName },
    labels: { nodes: [] }, comments: { nodes: [] },
  };
}

test('main(): refuses to dispatch a Marketing/distribution-project issue (BRO-2488)', async () => {
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => { exitCode = code; throw new Error('EXIT'); };
  const origError = console.error;
  const errors = [];
  console.error = (msg) => errors.push(msg);
  try {
    await assert.rejects(() => main(['--id', 'BRO-2488'], {
      getIssue: async () => makeMarketingIssue(),
      launchCmux: () => { throw new Error('launchCmux must not be called'); },
      appendLedgerEntry: () => { throw new Error('appendLedgerEntry must not be called for a Marketing-project issue'); },
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    }), /EXIT/);
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
  assert.equal(exitCode, 1);
  assert.match(errors.join('\n'), /Marketing\/distribution/);
});

test('main(): --force overrides the marketing-project refusal and proceeds to launch', async () => {
  const origError = console.error;
  console.error = () => {};
  let launched = false;
  try {
    await main(['--id', 'BRO-2488', '--force'], {
      getIssue: async () => makeMarketingIssue(),
      launchCmux: () => { launched = true; return { ok: true, ref: 'workspace:1', adoptedLate: false }; },
      cmuxAvailable: () => false,
      readLedgerEntries: () => [],
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
      ...noopLinearDeps(),
    });
  } finally {
    console.error = origError;
  }
  assert.equal(launched, true);
});

test('main(): a non-Marketing-project issue is unaffected by the guard (dry-run reaches the seed print)', async () => {
  const origLog = console.log;
  const logs = [];
  console.log = (msg) => logs.push(msg);
  try {
    await main(['--id', 'BRO-2488', '--dry-run'], {
      getIssue: async () => makeMarketingIssue('Infrastructure'),
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    });
  } finally {
    console.log = origLog;
  }
  assert.match(logs.join('\n'), /would launch/);
});

// ── auto-filed-pipeline dispatch guard, end-to-end (BRO-2499) ──────────────
// The other half of the SAME documented funnel line BRO-2488 closed
// ("Backlog/Todo, not `· Marketing`, not BSC Daily/CANARY"). BRO-2488's own
// root cause was a guard that COULD NEVER FIRE (issue.project was never
// fetched), so a pure-predicate test would not have caught it — these drive
// the real main() to prove the guard is actually wired into the --id path,
// and that the pipeline's opt-in flag really lets its own dispatch through.
function makeAutofixFiledIssue(title = 'BSC Daily: Cron failed: data-health-check') {
  return {
    id: 'issue-uuid-2499', identifier: 'BRO-9499', title,
    description: 'PARKED: Auto-filed by digest-autofix; runAutofix dispatches via linear-next separately in the same pass.\n\n## Acceptance criteria\n`node --test tests/unit/some-fixture.test.mjs`',
    url: 'https://linear.app/broadway-scorecard/issue/BRO-2499/bsc-daily-cron-failed',
    priority: 2,
    state: { id: 'state-1', name: 'Backlog', type: 'backlog' },
    project: { id: 'proj-2', name: 'Infrastructure' },
    labels: { nodes: [] }, comments: { nodes: [] },
  };
}

test('main(): refuses to dispatch a "BSC Daily:"-titled auto-filed issue (BRO-2499)', async () => {
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => { exitCode = code; throw new Error('EXIT'); };
  const origError = console.error;
  const errors = [];
  console.error = (msg) => errors.push(msg);
  try {
    await assert.rejects(() => main(['--id', 'BRO-9499'], {
      getIssue: async () => makeAutofixFiledIssue(),
      launchCmux: () => { throw new Error('launchCmux must not be called'); },
      appendLedgerEntry: () => { throw new Error('appendLedgerEntry must not be called for an auto-filed issue'); },
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    }), /EXIT/);
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
  assert.equal(exitCode, 1);
  assert.match(errors.join('\n'), /digest-autofix/);
});

test('main(): the daily CANARY card is refused the same way (BRO-2499)', async () => {
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => { exitCode = code; throw new Error('EXIT'); };
  const origError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(() => main(['--id', 'BRO-9499'], {
      getIssue: async () => makeAutofixFiledIssue('CANARY: touch data/audit/canary-2026-08-26.marker'),
      launchCmux: () => { throw new Error('launchCmux must not be called'); },
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    }), /EXIT/);
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
  assert.equal(exitCode, 1);
});

// The load-bearing half: digest-autofix.js and autofix-canary.js dispatch
// their own issues through this exact CLI. If this case fails, the daily
// autofix drain and the daily end-to-end canary have both stopped dispatching
// — a failure that would otherwise only surface ~24h later in the canary row.
test('main(): --allow-autofix-filed lets the owning pipeline dispatch its own issue (BRO-2499)', async () => {
  const origError = console.error;
  console.error = () => {};
  let launched = false;
  try {
    await main(['--id', 'BRO-9499', '--allow-autofix-filed'], {
      getIssue: async () => makeAutofixFiledIssue(),
      launchCmux: () => { launched = true; return { ok: true, ref: 'workspace:1', adoptedLate: false }; },
      cmuxAvailable: () => false,
      readLedgerEntries: () => [],
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
      // Unlike the --force cases above, this path does NOT bypass the
      // fresh-dispatch claim or the work-branch collision check — stub both
      // so this subprocess never writes a real claim into
      // data/audit/linear-dispatch-claims (a leftover claim makes the NEXT
      // run of this file take the refusal path and call the real
      // process.exit) and never shells out to git. Same convention as the
      // task #1898 claim tests above.
      acquireDispatchClaim: () => true,
      releaseDispatchClaim: () => {},
      listWorkBranchStatuses: () => [],
      ...noopLinearDeps(),
    });
  } finally {
    console.error = origError;
  }
  assert.equal(launched, true);
});

test('main(): an ordinary backlog issue is unaffected by the auto-filed guard (BRO-2499)', async () => {
  const origLog = console.log;
  const logs = [];
  console.log = (msg) => logs.push(msg);
  try {
    await main(['--id', 'BRO-9499', '--dry-run'], {
      getIssue: async () => ({ ...makeAutofixFiledIssue('Fix the score badge width'), description: '## Acceptance criteria\n`node --test tests/unit/some-fixture.test.mjs`' }),
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    });
  } finally {
    console.log = origLog;
  }
  assert.match(logs.join('\n'), /would launch/);
});

// ── started-state dispatch guard, end-to-end (BRO-2518) ────────────────────
// The third clause of the same documented funnel line BRO-2488/BRO-2499
// closed ("Backlog/Todo, not `· Marketing`, not BSC Daily/CANARY").
// checkTerminalStateGuard only ever refused TERMINAL types; nothing refused
// a STARTED one (In Progress / In Review) — these drive the real main() to
// prove the guard is actually wired into the --id path, the same way the
// BRO-2488/BRO-2499 tests above proved theirs.
function makeStartedIssue(stateName = 'In Progress') {
  return {
    id: 'issue-uuid-2518', identifier: 'BRO-2518', title: 'Some in-flight issue',
    description: '## Acceptance criteria\n`node --test tests/unit/some-fixture.test.mjs`',
    url: 'https://linear.app/broadway-scorecard/issue/BRO-2518/some-in-flight-issue',
    priority: 2,
    state: { id: 'state-1', name: stateName, type: 'started' },
    labels: { nodes: [] }, comments: { nodes: [] },
  };
}

test('main(): refuses to dispatch an In Progress issue (BRO-2518)', async () => {
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => { exitCode = code; throw new Error('EXIT'); };
  const origError = console.error;
  const errors = [];
  console.error = (msg) => errors.push(msg);
  try {
    await assert.rejects(() => main(['--id', 'BRO-2518'], {
      getIssue: async () => makeStartedIssue('In Progress'),
      launchCmux: () => { throw new Error('launchCmux must not be called'); },
      appendLedgerEntry: () => { throw new Error('appendLedgerEntry must not be called for a started issue'); },
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    }), /EXIT/);
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
  assert.equal(exitCode, 1);
  assert.match(errors.join('\n'), /already in a started state \("In Progress"\)/);
});

test('main(): refuses to dispatch an In Review issue too (BRO-2518)', async () => {
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => { exitCode = code; throw new Error('EXIT'); };
  const origError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(() => main(['--id', 'BRO-2518'], {
      getIssue: async () => makeStartedIssue('In Review'),
      launchCmux: () => { throw new Error('launchCmux must not be called'); },
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    }), /EXIT/);
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
  assert.equal(exitCode, 1);
});

test('main(): --force overrides the started-state refusal and proceeds to launch (BRO-2518)', async () => {
  const origError = console.error;
  console.error = () => {};
  let launched = false;
  try {
    await main(['--id', 'BRO-2518', '--force'], {
      getIssue: async () => makeStartedIssue('In Progress'),
      launchCmux: () => { launched = true; return { ok: true, ref: 'workspace:1', adoptedLate: false }; },
      cmuxAvailable: () => false,
      readLedgerEntries: () => [],
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
      ...noopLinearDeps(),
    });
  } finally {
    console.error = origError;
  }
  assert.equal(launched, true);
});

test('main(): a non-started (Backlog) issue is unaffected by the guard (dry-run reaches the seed print) (BRO-2518)', async () => {
  const origLog = console.log;
  const logs = [];
  console.log = (msg) => logs.push(msg);
  try {
    await main(['--id', 'BRO-2518', '--dry-run'], {
      getIssue: async () => ({ ...makeStartedIssue(), state: { id: 'state-1', name: 'Backlog', type: 'backlog' } }),
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    });
  } finally {
    console.log = origLog;
  }
  assert.match(logs.join('\n'), /would launch/);
});

// The load-bearing half of the acceptance criteria: the three machine
// dispatch paths (digest-autofix.js, autofix-canary.js,
// linear-drain-parked.js) must still dispatch their common case — a
// freshly-filed (backlog-type) or explicitly backlog/unstarted-filtered
// issue (see startedStateGuard's header in linear-dispatch.js) — this proves
// the auto-filed-pipeline path (BRO-2499's own load-bearing test above)
// still launches now that the started-state guard sits right next to it in
// the chain.
test('main(): --allow-autofix-filed still dispatches a freshly-filed (backlog) auto-filed issue with the started-state guard in place (BRO-2518 regression)', async () => {
  const origError = console.error;
  console.error = () => {};
  let launched = false;
  try {
    await main(['--id', 'BRO-9499', '--allow-autofix-filed'], {
      getIssue: async () => makeAutofixFiledIssue(),
      launchCmux: () => { launched = true; return { ok: true, ref: 'workspace:1', adoptedLate: false }; },
      cmuxAvailable: () => false,
      readLedgerEntries: () => [],
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
      acquireDispatchClaim: () => true,
      releaseDispatchClaim: () => {},
      listWorkBranchStatuses: () => [],
      ...noopLinearDeps(),
    });
  } finally {
    console.error = origError;
  }
  assert.equal(launched, true);
});

// Test gap closed (independent code-review finding on BRO-2518): the common
// case above is NOT the only one. digest-autofix.js's fileCard() dedups by
// exact-title match against LIVE Linear state — a reattach hit can land on
// an issue a PRIOR dispatch already moved to a started state (cross-host, or
// a stalled prior attempt), and runAutofix's dispatch-loop skip-list
// ('in-progress'/'card-failed'/'acknowledged'/'decision') does not include
// the 'card-filed' state a reattached row carries, so it reaches
// dispatchDetached the same as a freshly-filed row. Refusing here is the
// CORRECT outcome (this guard closing exactly that class of stray
// double-dispatch onto still-active work) — proving it explicitly, rather
// than assuming it, since a --allow-autofix-filed issue is exactly the
// population where a silent regression (dispatching a duplicate onto active
// work) would have been easy to miss.
test('main(): --allow-autofix-filed does NOT bypass the started-state guard — a reattached auto-filed issue already In Progress is still refused (BRO-2518)', async () => {
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => { exitCode = code; throw new Error('EXIT'); };
  const origError = console.error;
  const errors = [];
  console.error = (msg) => errors.push(msg);
  try {
    await assert.rejects(() => main(['--id', 'BRO-9499', '--allow-autofix-filed'], {
      getIssue: async () => ({ ...makeAutofixFiledIssue(), state: { id: 'state-1', name: 'In Progress', type: 'started' } }),
      launchCmux: () => { throw new Error('launchCmux must not be called'); },
      appendLedgerEntry: () => { throw new Error('appendLedgerEntry must not be called for a started issue'); },
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    }), /EXIT/);
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
  assert.equal(exitCode, 1);
  assert.match(errors.join('\n'), /already in a started state \("In Progress"\)/);
});

// bsc-next.js's own completedLaunchGuard (the Notion-mirror counterpart)
// self-exempts --dry-run/--print-prompt, and this file's own header/USAGE
// both document "--list/--dry-run still work" even under the kill switch —
// --dry-run on a TERMINAL issue must stay a side-effect-free preview, not a
// refusal, for the exact same reason.
test('main(): --dry-run on a completed issue still previews (terminal-state guard does not block previews)', async () => {
  const origLog = console.log;
  const logs = [];
  console.log = (msg) => logs.push(msg);
  try {
    await main(['--id', 'BRO-1517', '--dry-run'], {
      getIssue: async () => makeTerminalIssue('completed', 'Done'),
      appendLedgerEntry: () => {},
      listOpenIssuesWithDescriptions: async () => [],
      loadNotionMirrorTasks: () => [],
    });
  } finally {
    console.log = origLog;
  }
  assert.match(logs.join('\n'), /would launch/);
});

// Regression (2026-08-12): getTeam() returns states as a GraphQL connection
// ({nodes:[...]}), and pickStateForMode crashed on it (.find is not a
// function) — linear-brain.js create was broken on every invocation since
// it shipped. Normalization must accept both shapes.
test('pickStateForMode accepts both bare-array and {nodes} connection shapes', async () => {
  const { pickStateForMode } = await import('../../scripts/lib/linear-issue-create.js').then(m => m.default || m);
  const states = [ { id: 's1', name: 'Backlog', type: 'backlog' }, { id: 's2', name: 'Todo', type: 'unstarted' } ];
  assert.equal(pickStateForMode(states, 'dispatch').id, 's2');
  assert.equal(pickStateForMode({ nodes: states }, 'dispatch').id, 's2');
  assert.equal(pickStateForMode({ nodes: states }, 'park').id, 's1');
});

// BRO-287: reportDispatchOnIssue (scripts/linear-next.js) must move the
// issue to "In Progress" regardless of which shape getTeam() returns
// team.states in (bare array or GraphQL {nodes: [...]} connection) — the
// same {nodes}-shape class as pickStateForMode above, fixed here on
// 2026-08-12 but never given its own regression test until now. (A prior
// version of this fix duplicated the shape-check locally before handing off
// to lsr.pickStateByName/pickStateByType, which already normalize both
// shapes internally — that duplicate line was dead code, verified by
// deleting it and confirming these tests still pass unchanged; it has since
// been removed in favor of relying on lsr's normalization directly.) Drives
// the real function through its injected `deps.linear` seam, so no live
// Linear API call is made, for both shapes getTeam() can return.
function makeStubLinear(states, updateCalls, freshStateType = 'backlog') {
  return {
    createComment: async () => {},
    getTeam: async () => ({ states }),
    getIssue: async () => ({ state: { type: freshStateType } }),
    updateIssue: async (id, patch) => updateCalls.push({ id, patch }),
    TEAM_KEY: 'BRO',
  };
}

test('reportDispatchOnIssue: picks "In Progress" when getTeam() returns a bare states array', async () => {
  const states = [
    { id: 'backlog-1', name: 'Backlog', type: 'backlog' },
    { id: 'progress-1', name: 'In Progress', type: 'started' },
  ];
  const updateCalls = [];
  await reportDispatchOnIssue(
    { id: 'issue-1', identifier: 'BRO-1' }, 'ref', 'cmux', 'corr-1',
    { linear: makeStubLinear(states, updateCalls) }
  );
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].id, 'issue-1');
  assert.equal(updateCalls[0].patch.stateId, 'progress-1');
});

test('reportDispatchOnIssue: picks "In Progress" when getTeam() returns the {nodes} connection shape', async () => {
  const states = [
    { id: 'backlog-1', name: 'Backlog', type: 'backlog' },
    { id: 'progress-1', name: 'In Progress', type: 'started' },
  ];
  const updateCalls = [];
  await reportDispatchOnIssue(
    { id: 'issue-1', identifier: 'BRO-1' }, 'ref', 'cmux', 'corr-1',
    { linear: makeStubLinear({ nodes: states }, updateCalls) }
  );
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].id, 'issue-1');
  assert.equal(updateCalls[0].patch.stateId, 'progress-1');
});

test('reportDispatchOnIssue: no started-type state in the {nodes} shape leaves the issue untouched (warns, does not crash)', async () => {
  const states = [{ id: 'done-1', name: 'Done', type: 'completed' }];
  const updateCalls = [];
  const origError = console.error;
  const errors = [];
  console.error = (msg) => errors.push(msg);
  try {
    await reportDispatchOnIssue(
      { id: 'issue-1', identifier: 'BRO-1' }, 'ref', 'cmux', 'corr-1',
      { linear: makeStubLinear({ nodes: states }, updateCalls) }
    );
  } finally {
    console.error = origError;
  }
  assert.equal(updateCalls.length, 0);
  assert.match(errors.join('\n'), /no 'started'-type workflow state/);
});

// Live BRO-287 finding: for 'headless' mode, this function runs AFTER
// main() has awaited the worker session to full completion — by then the
// session may have already moved the issue itself (e.g. to "In Review" per
// its own completion instructions). Without a fresh re-check, this function
// would blindly overwrite that with "In Progress" using the stale `issue`
// object captured at dispatch time.
test('reportDispatchOnIssue: does not clobber a state the session already moved to since dispatch', async () => {
  const states = [
    { id: 'backlog-1', name: 'Backlog', type: 'backlog' },
    { id: 'progress-1', name: 'In Progress', type: 'started' },
  ];
  const updateCalls = [];
  const logs = [];
  const origLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await reportDispatchOnIssue(
      { id: 'issue-1', identifier: 'BRO-1', state: { type: 'backlog' } }, 'job-1', 'headless', 'corr-1',
      { linear: makeStubLinear(states, updateCalls, 'started') } // fresh getIssue() says it's now "started" (e.g. In Review)
    );
  } finally {
    console.log = origLog;
  }
  assert.equal(updateCalls.length, 0, 'must not overwrite a state the session already set');
  assert.match(logs.join('\n'), /already "started".*leaving its state alone/);
});

test('reportDispatchOnIssue: still claims the state when the fresh refetch confirms nothing else has moved it', async () => {
  const states = [
    { id: 'backlog-1', name: 'Backlog', type: 'backlog' },
    { id: 'progress-1', name: 'In Progress', type: 'started' },
  ];
  const updateCalls = [];
  await reportDispatchOnIssue(
    { id: 'issue-1', identifier: 'BRO-1', state: { type: 'backlog' } }, 'job-1', 'headless', 'corr-1',
    { linear: makeStubLinear(states, updateCalls, 'unstarted') } // fresh getIssue() confirms still Todo
  );
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].patch.stateId, 'progress-1');
});
