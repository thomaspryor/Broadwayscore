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
  findUnresolvedDispatchComment,
} from './linear-dispatch.js';
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
