// BRO-2466: the BRO team has THREE terminal state types (completed,
// canceled, duplicate), not two. This colocated test requires() the real
// linear-dispatch.js / linear-state-types.js so a production regression
// (someone hand-rolling `stateType === 'completed' || stateType ===
// 'canceled'` again instead of using isTerminalStateType) fails this test
// instead of drifting silently past it (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIssueQuery,
  buildOpenIssuesQuery,
  buildOpenIssuesWithDescriptionsQuery,
  checkTerminalStateGuard,
  marketingProjectGuard,
  autofixFiledIssueGuard,
  startedStateGuard,
  reportedOutcomeGuard,
  newestDispatchComment,
  dispatchCommentMode,
  dispatchFloor,
  RESOLVED_REPORT_STATUSES,
  REPORTED_WORK_BYPASS_FLAG,
  REPORTED_WORK_BYPASS_MIN_REASON,
  findUnresolvedDispatchComment,
} from './linear-dispatch.js';
import { buildOutcomeCommentBody, VALID_STATUSES } from './linear-session-reporting.js';
import { TERMINAL_STATE_TYPES, isTerminalStateType } from './linear-state-types.js';

test('TERMINAL_STATE_TYPES includes duplicate alongside completed/canceled', () => {
  assert.deepEqual([...TERMINAL_STATE_TYPES].sort(), ['canceled', 'completed', 'duplicate']);
});

test('isTerminalStateType: true for all three terminal types, false otherwise', () => {
  assert.equal(isTerminalStateType('completed'), true);
  assert.equal(isTerminalStateType('canceled'), true);
  assert.equal(isTerminalStateType('duplicate'), true);
  assert.equal(isTerminalStateType('started'), false);
  assert.equal(isTerminalStateType('backlog'), false);
  assert.equal(isTerminalStateType(undefined), false);
});

test('buildOpenIssuesQuery: excludes duplicate (not just completed/canceled) from the open-issue filter', () => {
  const query = buildOpenIssuesQuery();
  assert.match(query, /nin:\s*\["completed","canceled","duplicate"\]/);
});

test('buildOpenIssuesWithDescriptionsQuery: excludes duplicate too (rail 2 dedupe query)', () => {
  const query = buildOpenIssuesWithDescriptionsQuery();
  assert.match(query, /nin:\s*\["completed","canceled","duplicate"\]/);
});

test('checkTerminalStateGuard: refuses re-dispatch of a duplicate-type issue, names the state', () => {
  const issue = { identifier: 'BRO-2400', state: { type: 'duplicate', name: 'Duplicate' } };
  const refusal = checkTerminalStateGuard(issue);
  assert.match(refusal, /BRO-2400/);
  assert.match(refusal, /Duplicate/);
});

test('buildIssueQuery: fetches project so marketingProjectGuard can see it (BRO-2488)', () => {
  const query = buildIssueQuery();
  assert.match(query, /project\s*\{\s*name\s*\}/);
});

// BRO-2488: the documented dispatch funnel excludes "· Marketing" issues, but
// nothing enforced it — BRO-128 (Linear project "Marketing/distribution")
// dispatched cleanly with zero refusal. This must fail against the
// pre-fix behavior (issue.project was never fetched, so any check reading it
// evaluated against undefined and refused nothing).
test('marketingProjectGuard: refuses an issue in the Marketing/distribution project', () => {
  const issue = { identifier: 'BRO-128', project: { name: 'Marketing/distribution' } };
  const refusal = marketingProjectGuard(issue, {});
  assert.match(refusal, /BRO-128/);
  assert.match(refusal, /Marketing\/distribution/);
});

test('marketingProjectGuard: case/whitespace-insensitive on the project name', () => {
  const issue = { identifier: 'BRO-1', project: { name: '  MARKETING/DISTRIBUTION  ' } };
  assert.match(marketingProjectGuard(issue, {}), /BRO-1/);
});

test('marketingProjectGuard: a non-Marketing project is allowed', () => {
  const issue = { identifier: 'BRO-2', project: { name: 'Infrastructure' } };
  assert.equal(marketingProjectGuard(issue, {}), null);
});

test('marketingProjectGuard: no project set (undefined) is allowed — fails open like every other guard', () => {
  const issue = { identifier: 'BRO-3' };
  assert.equal(marketingProjectGuard(issue, {}), null);
});

test('marketingProjectGuard: --force bypasses the refusal', () => {
  const issue = { identifier: 'BRO-128', project: { name: 'Marketing/distribution' } };
  assert.equal(marketingProjectGuard(issue, { force: true }), null);
});

test('marketingProjectGuard: --dry-run and --print-prompt also bypass it (preview stays side-effect-free)', () => {
  const issue = { identifier: 'BRO-128', project: { name: 'Marketing/distribution' } };
  assert.equal(marketingProjectGuard(issue, { 'dry-run': true }), null);
  assert.equal(marketingProjectGuard(issue, { 'print-prompt': true }), null);
});

test('findUnresolvedDispatchComment: a "Dispatched ..." comment on a now-duplicate issue is not live', () => {
  const dispatched = { body: 'Dispatched abcd1234 to workspace-9 at 2026-08-01T00:00:00Z' };
  const issue = { state: { type: 'duplicate' }, comments: { nodes: [dispatched] } };
  assert.equal(findUnresolvedDispatchComment(issue), null);
});

// ── autofixFiledIssueGuard (BRO-2499) ───────────────────────────────────────
// The other half of the SAME documented funnel line marketingProjectGuard
// above closes: "Backlog/Todo, not `· Marketing`, not BSC Daily/CANARY". It
// was equally unenforced — a grep for CANARY/BSC Daily across linear-next.js,
// linear-dispatch.js and dispatch-guards.js returned only BRO-2488's own
// doc-quote comment. These cases fail against that pre-fix behaviour (no
// predicate existed at all, so nothing was ever refused).
//
// The guard is NOT a blanket title refusal: digest-autofix.js and
// autofix-canary.js dispatch these very issues themselves through
// `linear-next.js --id ... --headless`, so a blanket refusal would disable
// the daily autofix drain and the daily canary. Hence the opt-in bypass those
// two pipelines pass at their own call sites — covered by the last case here
// and, end-to-end, by digest-autofix.test.mjs's dispatchDetached argv test.

test('autofixFiledIssueGuard: a "BSC Daily: ..."-titled issue is REFUSED by the dispatch funnel', () => {
  const issue = { identifier: 'BRO-2500', title: 'BSC Daily: Cron failed: data-health-check' };
  const refusal = autofixFiledIssueGuard(issue, {});
  assert.match(refusal, /BRO-2500/);
  assert.match(refusal, /refusing to dispatch/);
  assert.match(refusal, /--force/);
  // Which pipeline the refusal NAMES depends on the PARKED provenance, not the
  // title — this fixture carries no description, so it is attributed to the
  // alert-router/drain owner. See the owner-attribution test below.
});

test('autofixFiledIssueGuard: the legacy "Fix: BSC Daily: ..." title variant is refused too', () => {
  const issue = { identifier: 'BRO-2501', title: 'Fix: BSC Daily: ScrapingBee credits low' };
  assert.match(autofixFiledIssueGuard(issue, {}), /BRO-2501/);
});

test('autofixFiledIssueGuard: the daily CANARY card is refused (canaryCardTitle shape)', () => {
  const issue = { identifier: 'BRO-2502', title: 'CANARY: touch data/audit/canary-2026-08-26.marker' };
  assert.match(autofixFiledIssueGuard(issue, {}), /BRO-2502/);
});

test('autofixFiledIssueGuard: provenance alone refuses, even if the title were renamed', () => {
  // linear-issue-create.js:141 writes `PARKED: <reason>` into the description;
  // digest-autofix.js's fileCard supplies AUTOFIX_FILED_MARKER as that reason.
  const issue = {
    identifier: 'BRO-2503',
    title: 'Renamed by hand to something ordinary',
    description: 'PARKED: Auto-filed by digest-autofix; runAutofix dispatches via linear-next separately in the same pass.\n\n## Problem\n...',
  };
  assert.match(autofixFiledIssueGuard(issue, {}), /BRO-2503/);
});

// BRO-2499 ship-check P2: provenance means "this filer created this issue",
// which only linear-issue-create.js:141's leading `PARKED: ` line attests. An
// unanchored substring match refuses any meta-issue that merely QUOTES the
// marker while discussing the pipeline — BRO-2499's own card is that shape.
test('autofixFiledIssueGuard: an issue that merely QUOTES the marker in its body is ALLOWED (BRO-2499)', () => {
  const issue = {
    identifier: 'BRO-2505',
    title: 'P1: the autofix guard is too broad',
    description: '## Problem\nThe guard keys on "Auto-filed by digest-autofix" appearing anywhere in the body, so this very issue is refused.\n\n## Acceptance criteria\n`node --test scripts/lib/linear-dispatch.test.mjs`',
  };
  assert.equal(autofixFiledIssueGuard(issue, {}), null);
});

test('autofixFiledIssueGuard: an ordinary backlog issue is ALLOWED', () => {
  assert.equal(autofixFiledIssueGuard({ identifier: 'BRO-1', title: 'Fix the score badge width' }, {}), null);
  assert.equal(autofixFiledIssueGuard({ identifier: 'BRO-2' }, {}), null);
  // An owner-alert-router tracker whose title does NOT follow the BSC Daily
  // convention is untouched.
  assert.equal(autofixFiledIssueGuard({
    identifier: 'BRO-3',
    title: 'Alert: prod deploy stale',
    description: 'PARKED: Auto-filed by owner-alert-router.',
  }, {}), null);
});

// BRO-2499 ship-check P0 (Codex): the two auto-filed populations are NOT
// disjoint by title. scripts/health-check.js:3951 routes actionable health
// rows through owner-alert-router with `title: "BSC Daily: <row>"`, so an
// alert-filed tracker carries the BSC Daily title with the OTHER PARKED
// marker. It is still machine-owned, so refusing a human/crown-loop `--id`
// on it is correct — but scripts/linear-drain-parked.js, which owns and
// dispatches that population, must pass the waiver. The first pass of this
// change did not, which would have silently refused every dispatch that
// drain made (its ledger records "attempted" either way, so the refusal
// would only have existed in the detached child's log file).
test('autofixFiledIssueGuard: an owner-alert-router tracker titled "BSC Daily:" is refused too — its drain must waive (BRO-2499)', () => {
  const issue = {
    identifier: 'BRO-2504',
    title: 'BSC Daily: ScrapingBee credits below threshold',
    description: 'PARKED: Auto-filed by owner-alert-router (condition: health-check:ScrapingBee credits); parked for triage.',
  };
  assert.match(autofixFiledIssueGuard(issue, {}), /BRO-2504/);
  assert.equal(autofixFiledIssueGuard(issue, { 'allow-autofix-filed': true }), null,
    'linear-drain-parked.js passes this waiver — without it that drain silently stops dispatching');
});

// Code-review finding: the refusal has to name the RIGHT owner. Sending an
// operator to digest-autofix's logs for an alert-router tracker (or vice
// versa) wastes the one action the message exists to enable.
test('autofixFiledIssueGuard: the refusal names the owning pipeline that actually filed it (BRO-2499)', () => {
  const digestOwned = {
    identifier: 'BRO-2506',
    title: 'BSC Daily: Cron failed: X',
    description: 'PARKED: Auto-filed by digest-autofix; runAutofix dispatches via linear-next separately in the same pass.',
  };
  const alertOwned = {
    identifier: 'BRO-2507',
    title: 'BSC Daily: ScrapingBee credits below threshold',
    description: 'PARKED: Auto-filed by owner-alert-router (condition: health-check:Credits); parked for triage.',
  };
  assert.match(autofixFiledIssueGuard(digestOwned, {}), /digest-autofix/);
  assert.match(autofixFiledIssueGuard(alertOwned, {}), /linear-drain-parked/);
  assert.doesNotMatch(autofixFiledIssueGuard(alertOwned, {}), /autofix dispatch is in flight/,
    'an alert-router tracker must not be blamed on the autofix pipeline — wrong log to check');
});

test('autofixFiledIssueGuard: --force/--dry-run/--print-prompt and the pipeline opt-in all bypass it', () => {
  const issue = { identifier: 'BRO-2500', title: 'BSC Daily: Cron failed: data-health-check' };
  assert.equal(autofixFiledIssueGuard(issue, { force: true }), null);
  assert.equal(autofixFiledIssueGuard(issue, { 'dry-run': true }), null);
  assert.equal(autofixFiledIssueGuard(issue, { 'print-prompt': true }), null);
  assert.equal(autofixFiledIssueGuard(issue, { 'allow-autofix-filed': true }), null,
    'digest-autofix / autofix-canary pass this flag — without the bypass the daily drain and canary stop dispatching');
});

// ── startedStateGuard (BRO-2518) ────────────────────────────────────────────
// The third clause of the same documented funnel line marketingProjectGuard
// (BRO-2488) and autofixFiledIssueGuard (BRO-2499) close — "Backlog/Todo,
// not `· Marketing`, not BSC Daily/CANARY". checkTerminalStateGuard only
// ever refused TERMINAL state types; nothing refused a STARTED one (In
// Progress / In Review), so 238 of 807 open issues on the live snapshot at
// filing time were freely dispatchable despite being mid-flight.

test('startedStateGuard: refuses an In Progress issue, names the state', () => {
  const issue = { identifier: 'BRO-2510', state: { type: 'started', name: 'In Progress' } };
  const refusal = startedStateGuard(issue, {});
  assert.match(refusal, /BRO-2510/);
  assert.match(refusal, /In Progress/);
});

test('startedStateGuard: refuses an In Review issue too — same "started" type', () => {
  const issue = { identifier: 'BRO-2511', state: { type: 'started', name: 'In Review' } };
  assert.match(startedStateGuard(issue, {}), /In Review/);
});

test('startedStateGuard: a Backlog issue is allowed', () => {
  const issue = { identifier: 'BRO-2512', state: { type: 'backlog', name: 'Backlog' } };
  assert.equal(startedStateGuard(issue, {}), null);
});

test('startedStateGuard: a Todo (unstarted) issue is allowed', () => {
  const issue = { identifier: 'BRO-2513', state: { type: 'unstarted', name: 'Todo' } };
  assert.equal(startedStateGuard(issue, {}), null);
});

test('startedStateGuard: a terminal-type issue (completed/canceled/duplicate) is allowed — checkTerminalStateGuard owns that refusal', () => {
  assert.equal(startedStateGuard({ identifier: 'BRO-2514', state: { type: 'completed', name: 'Done' } }, {}), null);
});

test('startedStateGuard: no state on the issue at all is allowed — fails open like every other guard', () => {
  assert.equal(startedStateGuard({ identifier: 'BRO-2515' }, {}), null);
});

test('startedStateGuard: --force/--dry-run/--print-prompt all bypass it', () => {
  const issue = { identifier: 'BRO-2516', state: { type: 'started', name: 'In Progress' } };
  assert.equal(startedStateGuard(issue, { force: true }), null);
  assert.equal(startedStateGuard(issue, { 'dry-run': true }), null);
  assert.equal(startedStateGuard(issue, { 'print-prompt': true }), null);
});

// Acceptance criteria: prove the three machine dispatch paths still
// dispatch. Each owns a population that is, by construction, never already
// started when it calls --id (see startedStateGuard's header for the
// per-caller check) — this guard must not refuse any of them.
test('startedStateGuard: a freshly-filed digest-autofix / canary / drain-parked issue (Backlog or Todo at file time) is never refused', () => {
  // digest-autofix.js's fileCard / autofix-canary.js's fileCard both create
  // issues that start in the team's default (backlog-type) state; linear-
  // drain-parked.js's selectDrainCandidates only ever selects from
  // PARKED_STATE_TYPES = backlog/unstarted (scripts/lib/linear-drain-
  // parked.js). None of these three ever hand --id a started-type issue.
  const freshlyFiled = { identifier: 'BRO-2517', state: { type: 'backlog', name: 'Backlog' } };
  const parkedCandidate = { identifier: 'BRO-2518', state: { type: 'unstarted', name: 'Todo' } };
  assert.equal(startedStateGuard(freshlyFiled, {}), null);
  assert.equal(startedStateGuard(parkedCandidate, {}), null);
});


// -- reportedOutcomeGuard (BRO-2543) -----------------------------------------
// BRO-2506's fix landed on origin/main at 00:53Z; its worker posted a session
// report at 01:31Z and the issue sat in In Review. At 02:15Z a crown-loop
// dead-session recovery ran `linear-next.js --id BRO-2506 --model opus
// --force` and a SECOND worker opened on it, re-did the discovery and closed
// with "duplicate dispatch - no new code needed". startedStateGuard above
// already refused that issue; --force cleared it. This guard is the one
// --force does not clear.

// The exact 02:15:05Z payload, reconstructed from BRO-2506's real comment
// thread: In Review, the 00:43 dispatch comment, the 01:31 session report,
// and nothing after (the 02:15 dispatch comment and 02:18 duplicate report
// only exist BECAUSE this guard wasn't there). Comments are newest-first,
// which is the order Linear's API actually returned them.
const BRO_2506_AT_INCIDENT = Object.freeze({
  identifier: 'BRO-2506',
  state: { id: 's1', name: 'In Review', type: 'started' },
  description: '## Acceptance criteria\n`node --test scripts/lib/digest-autofix.test.mjs`',
  comments: { nodes: [
    { body: '**Session report (in-review)**\n\nPorted the isDispatchResolved pattern from BRO-2434.', createdAt: '2026-08-31T01:31:24.775Z' },
    { body: 'Dispatched 0e0f245d to workspace:138 at 2026-08-31T00:43:00.598Z (cmux)', createdAt: '2026-08-31T00:43:00.704Z' },
  ] },
});

const clone = (o) => JSON.parse(JSON.stringify(o));

test('reportedOutcomeGuard: refuses the EXACT BRO-2506 incident — dead workspace, In Review, report already posted, --force passed', () => {
  // The literal command that wasted a dispatch: --id BRO-2506 --model opus --force.
  const refusal = reportedOutcomeGuard(BRO_2506_AT_INCIDENT, { force: true, model: 'opus' });
  assert.ok(refusal, 'the incident command must be refused');
  assert.match(refusal, /BRO-2506/);
  assert.match(refusal, /In Review/);
  assert.match(refusal, /session report \(in-review\)/);
  assert.match(refusal, /2026-08-31T01:31:24\.775Z/);
});

test('reportedOutcomeGuard: --force does NOT bypass it — the entire point of the guard', () => {
  // If this ever passes with force, BRO-2506 recurs verbatim.
  assert.ok(reportedOutcomeGuard(BRO_2506_AT_INCIDENT, {}));
  assert.ok(reportedOutcomeGuard(BRO_2506_AT_INCIDENT, { force: true }));
});

test('reportedOutcomeGuard: the refusal quotes the issue\'s own acceptance command and says --force will not help', () => {
  // SHOULD-FIX from the plan review: "read the report" is advice an LLM
  // operator skips; a pasteable command is one it runs.
  const refusal = reportedOutcomeGuard(BRO_2506_AT_INCIDENT, { force: true });
  assert.match(refusal, /node --test scripts\/lib\/digest-autofix\.test\.mjs/);
  assert.match(refusal, /--force alone does NOT bypass/);
  // The refusal must name the COMPLETE working recovery command, not just its
  // own flag: startedStateGuard independently refuses a started-type issue and
  // still wants --force, so an operator handed half the invocation bounces off
  // a second refusal. tests/unit/linear-next.test.mjs drives this exact flag
  // pair through the real main() and proves it dispatches.
  assert.match(refusal, new RegExp(`--force --${REPORTED_WORK_BYPASS_FLAG} "<reason`));
});

test('reportedOutcomeGuard: --allow-reported-work with a real reason is the escape hatch', () => {
  assert.equal(
    reportedOutcomeGuard(BRO_2506_AT_INCIDENT, { [REPORTED_WORK_BYPASS_FLAG]: 'checked main, the commit is not there' }),
    null,
  );
});

test('reportedOutcomeGuard: a BARE --allow-reported-work (no reason) does not bypass — a reflex is not a claim', () => {
  // parseArgs yields boolean true for a valueless flag. Requiring a reason is
  // what stops an operator reaching for this the instant the message names it.
  const refusal = reportedOutcomeGuard(BRO_2506_AT_INCIDENT, { [REPORTED_WORK_BYPASS_FLAG]: true });
  assert.ok(refusal);
  assert.match(refusal, /without a reason/);
  // ...and so does a too-short one.
  assert.ok(reportedOutcomeGuard(BRO_2506_AT_INCIDENT, { [REPORTED_WORK_BYPASS_FLAG]: 'oops' }));
});

test('reportedOutcomeGuard: --dry-run/--print-prompt bypass it — a preview launches nothing', () => {
  assert.equal(reportedOutcomeGuard(BRO_2506_AT_INCIDENT, { 'dry-run': true }), null);
  assert.equal(reportedOutcomeGuard(BRO_2506_AT_INCIDENT, { 'print-prompt': true }), null);
});

// -- the case the escape hatch exists for: it must stay dispatchable ---------

test('reportedOutcomeGuard: a BLOCKED session report never refuses — that is exactly the stall --force exists to recover', () => {
  // planCompletion() maps 'blocked' to NO state change, so a blocked worker's
  // report sits on an issue still in a started type. Refusing on any report
  // at all would have broken the crown loop's actual job.
  const blocked = clone(BRO_2506_AT_INCIDENT);
  blocked.comments.nodes[0].body = '**Session report (blocked)**\n\nMissing credential, cannot proceed.';
  assert.equal(reportedOutcomeGuard(blocked, { force: true }), null);
  assert.equal(reportedOutcomeGuard(blocked, {}), null);
});

test('reportedOutcomeGuard: a PAUSED session report never refuses either', () => {
  const paused = clone(BRO_2506_AT_INCIDENT);
  paused.comments.nodes[0].body = '**Session report (paused)**\n\nRECHECK-AFTER: 2026-09-15';
  assert.equal(reportedOutcomeGuard(paused, { force: true }), null);
});

test('reportedOutcomeGuard: only done/in-review count as resolved — pinned against the writer\'s own status list', () => {
  // Requires the REAL VALID_STATUSES so that adding a status upstream without
  // deciding which side of this line it falls on fails here (CLAUDE.md rule 15).
  assert.deepEqual([...VALID_STATUSES].sort(), ['blocked', 'done', 'in-review', 'paused']);
  assert.deepEqual([...RESOLVED_REPORT_STATUSES].sort(), ['done', 'in-review']);
  for (const status of VALID_STATUSES) {
    const issue = clone(BRO_2506_AT_INCIDENT);
    // Build the body with the REAL writer, never a hand-rolled copy of its format.
    issue.comments.nodes[0].body = buildOutcomeCommentBody({ summary: 'did a thing', status });
    const refused = !!reportedOutcomeGuard(issue, { force: true });
    assert.equal(refused, RESOLVED_REPORT_STATUSES.has(status), `status "${status}" refused=${refused}`);
  }
});

test('reportedOutcomeGuard: a report OLDER than the newest dispatch never refuses — a real re-dispatch that then died', () => {
  // The load-bearing ordering rule (dispatch-reconcile.js: "resolved by an
  // outcome recorded AT OR AFTER it, never by 'has an outcome somewhere in
  // history'"). Without it an issue re-dispatched after a genuine death would
  // stay refused forever on its previous run's report.
  const redispatched = clone(BRO_2506_AT_INCIDENT);
  redispatched.comments.nodes.unshift({
    body: 'Dispatched aaaa1111 to workspace:99 at 2026-08-31T05:00:00.000Z (cmux)',
    createdAt: '2026-08-31T05:00:00.000Z',
  });
  assert.equal(reportedOutcomeGuard(redispatched, { force: true }), null);
  assert.equal(reportedOutcomeGuard(redispatched, {}), null);
});

test('reportedOutcomeGuard: a report after the NEWEST of several dispatch comments refuses again', () => {
  // The mirror of the case above — proves the ordering rule is a real
  // comparison and not a blanket "more than one dispatch comment ⇒ allow".
  const reported = clone(BRO_2506_AT_INCIDENT);
  reported.comments.nodes.unshift(
    { body: '**Session report (done)**\n\nSecond run finished it.', createdAt: '2026-08-31T06:00:00.000Z' },
    { body: 'Dispatched aaaa1111 to workspace:99 at 2026-08-31T05:00:00.000Z (cmux)', createdAt: '2026-08-31T05:00:00.000Z' },
  );
  assert.ok(reportedOutcomeGuard(reported, { force: true }));
});

// -- the second signal: PR-EVIDENCE ------------------------------------------

test('reportedOutcomeGuard: a PR-EVIDENCE comment refuses even with no session report at all', () => {
  // Covers the worker that commits and dies before reporting, and every
  // worker still in flight under the pre-BRO-2543 seed (which told them to
  // hand-roll commentCreate, producing no recognisable report header).
  const prEvidence = clone(BRO_2506_AT_INCIDENT);
  prEvidence.comments.nodes[0] = {
    body: 'All done here.\n\nPR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/commit/f3262ef00d5)',
    createdAt: '2026-08-31T01:31:24.775Z',
  };
  const refusal = reportedOutcomeGuard(prEvidence, { force: true });
  assert.ok(refusal);
  assert.match(refusal, /PR-EVIDENCE marker/);
});

// -- must never fire ---------------------------------------------------------

test('reportedOutcomeGuard: a Backlog/Todo/terminal issue is never refused, however many reports it carries', () => {
  // The three machine dispatch paths (digest-autofix, canary, drain-parked)
  // only ever hand --id a backlog- or unstarted-type issue, so none of them
  // can be refused by this guard regardless of thread contents.
  for (const state of [
    { type: 'backlog', name: 'Backlog' },
    { type: 'unstarted', name: 'Todo' },
    { type: 'completed', name: 'Done' },
    { type: 'canceled', name: 'Canceled' },
  ]) {
    const issue = clone(BRO_2506_AT_INCIDENT);
    issue.state = state;
    assert.equal(reportedOutcomeGuard(issue, {}), null, `state ${state.type} must not be refused`);
  }
});

test('reportedOutcomeGuard: an issue with no comments / no state / malformed nodes fails open and never throws', () => {
  assert.equal(reportedOutcomeGuard({ identifier: 'BRO-1' }, {}), null);
  assert.equal(reportedOutcomeGuard({ identifier: 'BRO-1', state: { type: 'started' } }, {}), null);
  assert.equal(reportedOutcomeGuard({ identifier: 'BRO-1', state: { type: 'started' }, comments: { nodes: null } }, {}), null);
  assert.equal(reportedOutcomeGuard({ identifier: 'BRO-1', state: { type: 'started' }, comments: { nodes: [null, {}, { body: 42 }] } }, {}), null);
  assert.equal(reportedOutcomeGuard(null, {}), null);
});

test('reportedOutcomeGuard: a report with no createdAt cannot be ordered, so it fails OPEN', () => {
  // Absent ordering information the guard must not refuse — matching every
  // other guard in this file, and keeping legacy/fixture payloads dispatchable.
  const noTs = { identifier: 'BRO-1', state: { type: 'started', name: 'In Review' }, comments: { nodes: [
    { body: '**Session report (done)**\n\nfinished' },
  ] } };
  assert.equal(reportedOutcomeGuard(noTs, {}), null);
});

test('reportedOutcomeGuard: a session report is matched only at the START of a body — quoting one does not count', () => {
  // The refusal text itself names the format; a worker pasting it back into
  // the thread must not thereby manufacture a "report".
  const quoted = clone(BRO_2506_AT_INCIDENT);
  quoted.comments.nodes[0].body = 'The guard said:\n\n**Session report (done)** was already posted';
  assert.equal(reportedOutcomeGuard(quoted, { force: true }), null);
});

// -- newestDispatchComment ordering (the bug the incident exposed) -----------

test('newestDispatchComment: picks the newest by createdAt from a NEWEST-FIRST array (Linear\'s real order)', () => {
  // Linear's `comments` connection has no orderBy in buildIssueQuery, so it
  // returns its default — updatedAt DESCENDING. Verified live on BRO-2506.
  // The old `dispatched[length - 1]` returned the OLDEST here.
  const newestFirst = [
    { body: 'Dispatched cd34 to workspace:2 at t2 (cmux)', createdAt: 't2' },
    { body: 'Dispatched ab12 to workspace:1 at t1 (cmux)', createdAt: 't1' },
    { body: 'unrelated comment', createdAt: 't0' },
  ];
  assert.equal(newestDispatchComment(newestFirst).createdAt, 't2');
});

test('newestDispatchComment: also picks the newest from an OLDEST-FIRST array', () => {
  const oldestFirst = [
    { body: 'unrelated comment', createdAt: 't0' },
    { body: 'Dispatched ab12 to workspace:1 at t1 (cmux)', createdAt: 't1' },
    { body: 'Dispatched cd34 to workspace:2 at t2 (cmux)', createdAt: 't2' },
  ];
  assert.equal(newestDispatchComment(oldestFirst).createdAt, 't2');
});

test('newestDispatchComment: with no timestamps at all, last-in-array still wins (old behaviour preserved)', () => {
  const noTs = [
    { body: 'Dispatched ab12 to workspace:1 at t1 (cmux)', id: 'first' },
    { body: 'Dispatched cd34 to workspace:2 at t2 (cmux)', id: 'last' },
  ];
  assert.equal(newestDispatchComment(noTs).id, 'last');
});

test('newestDispatchComment: null for an empty/absent list', () => {
  assert.equal(newestDispatchComment([]), null);
  assert.equal(newestDispatchComment(null), null);
});

test('REPORTED_WORK_BYPASS_MIN_REASON is long enough that a reflex answer will not clear it', () => {
  assert.ok(REPORTED_WORK_BYPASS_MIN_REASON >= 10);
});


// -- headless dispatch ordering (adversarial pre-ship review) ---------------
//
// The first cut of this guard compared a report against the newest dispatch
// comment's createdAt unconditionally. That is right for cmux (the comment is
// posted immediately after launch) and WRONG for headless: linear-next.js
// awaits runJob() to completion and only then calls reportDispatchOnIssue(),
// past an `if (!res.ok) return` — so a headless "Dispatched ..." comment is
// written at the END of a job that succeeded, and the worker's own report is
// necessarily older than it. The guard silently ignored that report on every
// headless dispatch: a false negative on exactly the case it exists for.

const HEADLESS_DISPATCHED = 'Dispatched 0e0f245d to headless:linear:BRO-2506 at 2026-08-31T02:00:00.000Z (headless)';
const CMUX_DISPATCHED = 'Dispatched 0e0f245d to workspace:138 at 2026-08-31T00:43:00.598Z (cmux)';

test('dispatchCommentMode: reads the trailing (mode) buildDispatchComment writes', () => {
  assert.equal(dispatchCommentMode({ body: CMUX_DISPATCHED }), 'cmux');
  assert.equal(dispatchCommentMode({ body: HEADLESS_DISPATCHED }), 'headless');
  assert.equal(dispatchCommentMode({ body: 'Dispatched abc to workspace:1 at t' }), null);
  assert.equal(dispatchCommentMode(null), null);
});

test('reportedOutcomeGuard: a HEADLESS dispatch whose report predates its own comment still refuses', () => {
  // Report at 01:31, headless dispatch comment at 02:00 (written when the job
  // finished). Naive ordering discards the report; the mode-aware floor keeps it.
  const issue = {
    identifier: 'BRO-2506',
    state: { name: 'In Review', type: 'started' },
    description: '## Acceptance criteria\n`node --test scripts/lib/digest-autofix.test.mjs`',
    comments: { nodes: [
      { body: HEADLESS_DISPATCHED, createdAt: '2026-08-31T02:00:00.000Z' },
      { body: '**Session report (in-review)**\n\nFix landed.', createdAt: '2026-08-31T01:31:24.775Z' },
    ] },
  };
  const refusal = reportedOutcomeGuard(issue, { force: true });
  assert.ok(refusal, 'a headless worker report must not be discarded as "older than the dispatch"');
  assert.match(refusal, /session report \(in-review\)/);
});

test('reportedOutcomeGuard: a headless re-dispatch after an EARLIER cmux run only counts reports from the newer window', () => {
  // Thread: cmux dispatch 00:43 -> report 01:31 -> headless re-dispatch
  // comment 05:00. The headless floor is the previous dispatch comment
  // (00:43), so the 01:31 report still counts — correct, because that headless
  // comment proves its own job ran to completion.
  const issue = {
    identifier: 'BRO-2506',
    state: { name: 'In Review', type: 'started' },
    comments: { nodes: [
      { body: HEADLESS_DISPATCHED.replace('02:00:00', '05:00:00'), createdAt: '2026-08-31T05:00:00.000Z' },
      { body: '**Session report (in-review)**\n\nFix landed.', createdAt: '2026-08-31T01:31:24.775Z' },
      { body: CMUX_DISPATCHED, createdAt: '2026-08-31T00:43:00.704Z' },
    ] },
  };
  assert.ok(reportedOutcomeGuard(issue, { force: true }));
});

test('reportedOutcomeGuard: a CMUX re-dispatch after a report still allows — the cmux floor is its own createdAt', () => {
  // The mode-aware floor must not weaken the cmux case: a cmux dispatch
  // comment IS posted at launch, so a report older than it belongs to a
  // previous run and a genuine recovery must stay dispatchable.
  const issue = {
    identifier: 'BRO-2506',
    state: { name: 'In Review', type: 'started' },
    comments: { nodes: [
      { body: CMUX_DISPATCHED.replace('00:43:00.598', '05:00:00.000'), createdAt: '2026-08-31T05:00:00.000Z' },
      { body: '**Session report (in-review)**\n\nFix landed.', createdAt: '2026-08-31T01:31:24.775Z' },
      { body: CMUX_DISPATCHED, createdAt: '2026-08-31T00:43:00.704Z' },
    ] },
  };
  assert.equal(reportedOutcomeGuard(issue, { force: true }), null);
});

test('dispatchFloor: cmux uses its own ts; headless falls back to the previous dispatch comment, else empty', () => {
  const cmux = { body: CMUX_DISPATCHED, createdAt: 't5' };
  assert.equal(dispatchFloor(cmux, [cmux]), 't5');
  const headless = { body: HEADLESS_DISPATCHED, createdAt: 't5' };
  assert.equal(dispatchFloor(headless, [headless]), '', 'no previous dispatch ⇒ no lower bound');
  const prior = { body: CMUX_DISPATCHED, createdAt: 't1' };
  assert.equal(dispatchFloor(headless, [headless, prior]), 't1');
});

test('reportedOutcomeGuard: no "Dispatched ..." comment at all fails OPEN, however many reports exist', () => {
  // With no identified outstanding dispatch there is nothing to order against,
  // and on a long thread the dispatch comment may simply have fallen outside
  // the fetched window — a confident refusal built on a truncated view is
  // worse than none. (Pre-ship review: `since=''` previously let any historical
  // outcome block dispatch here.)
  const issue = {
    identifier: 'BRO-2506',
    state: { name: 'In Review', type: 'started' },
    comments: { nodes: [
      { body: '**Session report (done)**\n\nAncient history.', createdAt: '2026-01-01T00:00:00.000Z' },
    ] },
  };
  assert.equal(reportedOutcomeGuard(issue, {}), null);
  assert.equal(reportedOutcomeGuard(issue, { force: true }), null);
});

test('reportedOutcomeGuard: REPORTED_OUTCOME_GUARD_DISABLED=1 is the incident rollback path', () => {
  // The only non-per-dispatch way out. LINEAR_NEXT_DISABLED cannot serve here:
  // it is checked AFTER this guard and kills the whole dispatcher.
  const prev = process.env.REPORTED_OUTCOME_GUARD_DISABLED;
  try {
    process.env.REPORTED_OUTCOME_GUARD_DISABLED = '1';
    assert.equal(reportedOutcomeGuard(BRO_2506_AT_INCIDENT, {}), null);
  } finally {
    if (prev === undefined) delete process.env.REPORTED_OUTCOME_GUARD_DISABLED;
    else process.env.REPORTED_OUTCOME_GUARD_DISABLED = prev;
  }
  // ...and it is off by default: the same call refuses again once unset.
  assert.ok(reportedOutcomeGuard(BRO_2506_AT_INCIDENT, {}));
});
