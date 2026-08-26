#!/usr/bin/env node
/**
 * linear-next.js — thin Linear-issue dispatcher (task #1303 / BRO-266 Linear
 * transition). Fetches a Linear issue via GraphQL and launches a Claude Code
 * worker on it, reusing the SAME battle-tested launch primitives bsc-next.js
 * uses for Notion-mirror tasks:
 *   - scripts/lib/cmux-launch.js's launchCmuxSession() for the cmux-tab path
 *     (the canonical --dangerously-skip-permissions flow is baked into that
 *     primitive itself, not re-typed here)
 *   - scripts/lib/bsc-runner.js's runJob() for --headless
 *   - scripts/lib/dispatch-ledger.js so bsc-prune/reconcile/watchdog see
 *     Linear dispatches exactly like Notion-mirror ones
 *   - scripts/lib/dispatch-guards.js's six shared guard/gate predicates
 *     (findLiveWorkspaceForTask, checkDeadDispatch, parkedGuard,
 *     evaluateVerifiability, classifyHeadlessDispatchability) — extracted
 *     out of bsc-next.js (task #1303 plan review) so both dispatchers share
 *     ONE set of refusals instead of forking them. See that file's header.
 *   - scripts/lib/linear-client.js for every Linear API call (issue fetch,
 *     open-issue list, comment, state update) — the CI gate
 *     (audit-linear-issuecreate-chokepoint.js) fails any reference to
 *     Linear's GraphQL endpoint outside that file, so this script never
 *     talks to Linear directly.
 *
 * Ledger taskId namespace: `linear:<identifier>` (e.g. `linear:BRO-123`) —
 * distinct from bare numeric Notion task ids so a Linear dispatch can never
 * collide with (or be mistaken for) a Notion-mirror one in the shared
 * dispatch-ledger.jsonl. Every dispatch also gets a `linearId` field on its
 * ledger entries for anything that wants to filter Linear-origin launches.
 *
 * Idempotency (task #1303 plan review item 4): before launching, this
 * refuses if EITHER (a) the issue's own comment thread already carries an
 * unresolved "Dispatched ..." comment, or (b) the local dispatch ledger has
 * a live (non-dead, non-finished) entry for this issue — two independent
 * signals, since (a) survives a lost/rotated local ledger or a dispatch from
 * a different machine, and (b) is cheap and cross-checks (a). The ledger
 * 'launch' entry (carrying verifyCmd + linearId + a correlationId) is always
 * written BEFORE the Linear comment/state mutation, so a crash mid-sequence
 * leaves the ledger as the more-current record and a retry's idempotency
 * check on (b) still catches it even if (a) never landed.
 *
 * On a successful dispatch: posts "Dispatched <correlationId> to <ref> at
 * <ts>" as a comment on the issue and moves it to the team's "started"-type
 * workflow state (In Progress) — so a second, accidental dispatch is visible
 * on the Linear board itself, not just in a local ledger file.
 *
 * Usage:
 *   node scripts/linear-next.js --id BRO-123                 launch a cmux tab (default)
 *   node scripts/linear-next.js --id BRO-123 --headless      run as a supervised background job (bsc-runner)
 *   node scripts/linear-next.js --id BRO-123 --tab           force a cmux tab (overrides --headless)
 *   node scripts/linear-next.js --list                       open BRO issues, priority-sorted
 *   node scripts/linear-next.js --id BRO-123 --model opus    override the resolved model
 *   node scripts/linear-next.js --id BRO-123 --force         bypass duplicate/dead-dispatch/parked/idempotency/terminal-state guards
 *   node scripts/linear-next.js --id BRO-123 --allow-unverifiable  dispatch with no runnable "## Acceptance criteria" command
 *   node scripts/linear-next.js --id BRO-123 --allow-human-gated   dispatch --headless even when the issue needs a human to finish it
 *   node scripts/linear-next.js --id BRO-123 --dry-run       print the seed prompt, launch nothing
 *   node scripts/linear-next.js --help, -h                   show this message, do nothing else
 *
 * Kill switch: LINEAR_NEXT_DISABLED=1 refuses ALL dispatch (both cmux-tab
 * and --headless — this whole dispatcher is new, so this is stricter than
 * BSC_RUNNER_DISABLED, which only ever killed the headless half of
 * bsc-next.js). --list and --dry-run still work under the kill switch — it
 * blocks LAUNCHING, not reading.
 *
 * Machine-bound routing (v1): an issue labeled 'mac-only' always gets a local
 * cmux tab, whatever --headless/--tab flag was passed — see
 * scripts/lib/linear-dispatch.js's decideRouting(). No Cyrus/queue routing
 * yet (--decide is explicitly out of scope for #1303).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

require('./lib/load-env').loadEnv();

const linear = require('./lib/linear-client.js');
const ld = require('./lib/linear-dispatch.js');
const lsr = require('./lib/linear-session-reporting.js');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { launchCmuxSession } = require('./lib/cmux-launch.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const cmuxws = require('./lib/cmux-workspaces.js');
const { buildAutoTitle, projectOf } = require('./lib/workspace-naming.js');
const { resolveModel } = require('./lib/bsc-next-model.js');
// The shared guard/gate lib (task #1303 plan review item 2) — see that
// file's header for the DispatchGuardTask shape these expect.
const {
  findLiveWorkspaceForTask, checkDeadDispatch, parkedGuard,
  evaluateVerifiability, classifyHeadlessDispatchability, HEADLESS_BLOCKERS,
  exactTitleOverlapGuard, sessionTrackingCloneGuard, dispatchClaimGuard,
  workBranchCollisionGuard,
} = require('./lib/dispatch-guards.js');
const { findOverlappingCards } = require('./lib/dispatch-overlap-check.js');
// Cross-session work-branch collision guard (BRO-278, port of card #1281's
// bsc-next.js check — see docs/dispatcher-safety-port-table.md row A5). Was
// never wired into this dispatcher; combined with dispatch-guards.js's own
// id-sanitization gap, every Linear-issue collision was invisible.
const { listWorkBranchStatuses } = require('./lib/worktree-branch-guard.js');
// Mirror-staleness dispatch claim (task #1898, parity with bsc-next.js's
// task #1896 fix) — same shared primitive, separate claim dir/id-space (see
// DISPATCH_CLAIM_DIR below).
const { acquireClaim, releaseClaim } = require('./lib/atomic-claim.js');

// Hardcoded, not __dirname-relative: this script is routinely run from
// inside a worktree (this session included), and a relative REPO would
// resolve into that worktree's own tree instead of the canonical checkout —
// the same fix dispatch-ledger.js and bsc-next.js already apply to their own
// REPO constants, for the same reason (their header comments explain why).
const REPO = '/Users/tompryor/Broadwayscore';

const CLI_NAME = 'scripts/linear-next.js';

// Fresh-dispatch claim (task #1898, mirrors bsc-next.js's DISPATCH_CLAIM_DIR
// from task #1896) — a SEPARATE dir from bsc-next.js's own dispatch-claims/,
// since Linear issue ids (`BRO-123`) and Notion task ids are different id
// spaces that could theoretically collide as bare strings. Same 8-minute
// staleMs as bsc-next.js's, for the same reason (cmux-launch.js's
// slowBootCapSec allows up to 6 minutes of boot).
const DISPATCH_CLAIM_DIR = path.join(REPO, 'data', 'audit', 'linear-dispatch-claims');
const DISPATCH_CLAIM_STALE_MS = 8 * 60 * 1000;

const USAGE = `linear-next — fetch a Linear issue and dispatch a Claude Code worker on it.

Usage:
  node scripts/linear-next.js --id BRO-123                 launch a cmux tab (default)
  node scripts/linear-next.js --id BRO-123 --headless       run as a supervised background job (bsc-runner)
  node scripts/linear-next.js --id BRO-123 --tab            force a cmux tab (overrides --headless)
  node scripts/linear-next.js --list                        list open BRO issues, priority-sorted
  node scripts/linear-next.js --id BRO-123 --model opus     override the resolved model
  node scripts/linear-next.js --id BRO-123 --force          bypass duplicate/dead-dispatch/parked/idempotency/terminal-state guards
  node scripts/linear-next.js --id BRO-123 --allow-unverifiable  dispatch with no runnable "## Acceptance criteria" command
  node scripts/linear-next.js --id BRO-123 --allow-human-gated   dispatch --headless even when the issue needs a human to finish it
  node scripts/linear-next.js --id BRO-123 --dry-run        print the seed prompt, launch nothing
  node scripts/linear-next.js --help, -h                    show this message, do nothing else

Kill switch: LINEAR_NEXT_DISABLED=1 refuses ALL dispatch (--list/--dry-run
still work). Machine-bound routing: an issue tagged 'mac-only' always forces
a local cmux tab, overriding --headless. No --decide / Cyrus routing yet.
`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}

function ledgerTaskId(identifier) { return `linear:${identifier}`; }

// Notion-mirror task dir (~/.claude/tasks/<list-id>/*.json) — the SAME
// directory bsc-next.js's loadTasks() reads (task #1696). Duplicated here
// (not required from bsc-next.js) rather than importing a CLI entry point
// whose main() runs under `require.main === module` — every other dispatcher
// script in this repo (autonomous-triage.js, notion-tasks-sync.js, etc.)
// re-derives this same small block instead of cross-requiring bsc-next.js.
const LIST_ID = process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', LIST_ID);

function loadNotionMirrorTasks(dir = TASKS_DIR) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

// Cross-task/cross-system overlap check (task #1696 — the #917/#1672 class,
// extended to the Linear side). bsc-next.js's own overlap check only ever
// compared its dispatch against OTHER Notion-mirror tasks; a Linear-issue
// dispatch can duplicate work already live on EITHER side of the Notion<->
// Linear mirror, so the comparison pool combines both:
//   - live Linear issues (state.type === 'started' — Linear's "in progress"
//     workflow-state type, the same one reportDispatchOnIssue() above moves
//     an issue INTO), excluding this dispatch's own issue
//   - in_progress Notion-mirror tasks (the exact pool bsc-next.js's own
//     overlap check builds from tasksWithArchive)
// Pure — no I/O — so it's directly unit-testable against fixture data
// (CLAUDE.md rule 15) without a live Linear/Notion round trip.
function buildOverlapComparisonPool(openLinearIssuesWithDesc, notionMirrorTasks, selfIdentifier) {
  const linearPool = (openLinearIssuesWithDesc || [])
    .filter((iss) => iss && iss.identifier !== selfIdentifier && iss.state && iss.state.type === 'started')
    .map((iss) => ({ id: iss.identifier, subject: iss.title, description: iss.description || '', status: 'in_progress' }));
  const notionPool = (notionMirrorTasks || [])
    .filter((t) => t && t.status === 'in_progress')
    .map((t) => ({ id: t.id, subject: t.subject, description: t.description || '', status: t.status }));
  return linearPool.concat(notionPool);
}

// Pure: runs dispatch-guards.js's sessionTrackingCloneGuard + exactTitleOverlapGuard
// over a pre-built comparison pool (see buildOverlapComparisonPool above),
// same shape/ordering bsc-next.js's main() uses (clone check first, then the
// exact-title refusal, then non-blocking warnings for the rest). Returns
// { refusal, warnings } — refusal is a string or null (caller exits on it),
// warnings is an array of printable strings for non-blocking overlaps.
function checkLinearOverlapGuards(pseudoTask, pool, opts) {
  const cloneErr = sessionTrackingCloneGuard(pseudoTask, pool, opts);
  if (cloneErr) return { refusal: cloneErr, warnings: [] };

  const overlapCards = pool.map((t) => ({ id: t.id, subject: t.subject, notes: t.description }));
  const targetCard = { id: pseudoTask.id, subject: pseudoTask.subject, notes: pseudoTask.description };
  const overlaps = findOverlappingCards(targetCard, overlapCards);
  const overlapErr = exactTitleOverlapGuard(pseudoTask, overlaps, opts);
  if (overlapErr) return { refusal: overlapErr, warnings: [] };

  const warnings = overlaps.map((o) => {
    const why = o.reason === 'exact-title-match'
      ? 'has an exact title match (refusal bypassed via --force/--dry-run/--print-prompt)'
      : o.reason === 'shared-file-path' ? `shares file(s) ${o.sharedPaths.join(', ')}` : 'has a near-identical title';
    return `${pseudoTask.id} ${why} with in_progress work ${o.card.id} ("${o.card.subject}") — check it isn't already being worked before dispatching a duplicate.`;
  });
  return { refusal: null, warnings };
}

async function runList() {
  const issues = await linear.listOpenIssues();
  const sorted = ld.sortIssuesByPriority(issues);
  console.log(`Open ${linear.TEAM_KEY} issues (${sorted.length}), priority-sorted:`);
  sorted.slice(0, 25).forEach((iss, i) => {
    const labels = ld.issueLabelNames(iss);
    const stateName = (iss.state && iss.state.name) || '?';
    console.log(`  ${i + 1}. ${iss.identifier} [${ld.priorityLabel(iss)}] [${stateName}]${labels.length ? ` [${labels.join(',')}]` : ''} ${iss.title}`);
  });
}

// Best-effort: an issue-side write failing must never turn a VERIFIED launch
// into a reported failure — the dispatch already happened and is already
// journaled locally (BEFORE this runs — see the header's ordering note).
// Logs and moves on.
async function reportDispatchOnIssue(issue, ref, mode, correlationId, deps = {}) {
  const linearClient = deps.linear || linear; // test seam — see reportDispatchOnIssue tests in tests/unit/linear-next.test.mjs
  try {
    const body = ld.buildDispatchComment({ ref, ts: new Date().toISOString(), mode, correlationId });
    await linearClient.createComment(issue.id, body);
  } catch (e) { console.error(`[linear-next] WARN could not post dispatch comment on ${issue.identifier}: ${e.message}`); }
  try {
    const team = await linearClient.getTeam();
    // Team BRO has TWO states of type 'started' (In Progress, In Review) —
    // the old `.find(s => s.type === 'started')` picked whichever one the
    // API happened to return first, order-dependent and unverified against a
    // name. That silently landed dispatched issues in "In Review" instead of
    // "In Progress" (caught reviewing BRO-387 itself, which was sitting in
    // "In Review" with zero work done on it). Prefer the literal "In
    // Progress" name; fall back to the first started-type state only if that
    // exact name doesn't exist on this team.
    // team.states can be a bare array or getTeam()'s raw GraphQL {nodes: [...]}
    // connection shape — pickStateByName/pickStateByType normalize either via
    // their own normalizeStates(), so team.states is passed through as-is
    // rather than re-normalized here (BRO-287: an earlier inline
    // normalization duplicating that logic was provably dead — pickStateByName
    // already unwraps {nodes} internally, so the duplicate had no effect on
    // behavior and made the {nodes}-shape regression test it was meant to
    // guard untestable).
    const started =
      lsr.pickStateByName(team.states, lsr.CLAIM_STATE_NAME) || lsr.pickStateByType(team.states, 'started');
    if (!started) { console.error(`[linear-next] WARN no 'started'-type workflow state on team ${linearClient.TEAM_KEY} — leaving ${issue.identifier}'s state unchanged`); return; }
    // For 'headless' mode this runs AFTER the worker session has already
    // finished (main() awaits runJob() to completion before calling this —
    // see the caller) and may itself have moved the issue on completion
    // (e.g. to "In Review" or "Done" per its own instructions, or a human
    // could have touched it in the meantime). `issue` here is the object
    // fetched at DISPATCH time, now stale, so blindly writing stateId would
    // silently clobber whatever ran during that window. Re-fetch and only
    // claim the state if it's still sitting where it was at dispatch
    // (backlog/unstarted) — found live (BRO-287): this exact function would
    // have overwritten the "In Review" state the BRO-287 session set on
    // itself moments before exiting.
    let currentType = issue.state && issue.state.type;
    try {
      const fresh = await linearClient.getIssue(issue.identifier);
      if (fresh && fresh.state) currentType = fresh.state.type;
    } catch (e) { /* refetch failure — fall back to the stale type below rather than block the claim */ }
    if (currentType && currentType !== 'backlog' && currentType !== 'unstarted') {
      console.log(`[linear-next] ${issue.identifier} is already "${currentType}" (moved since dispatch) — leaving its state alone`);
      return;
    }
    await linearClient.updateIssue(issue.id, { stateId: started.id });
  } catch (e) { console.error(`[linear-next] WARN could not move ${issue.identifier} to In Progress: ${e.message}`); }
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    getIssue: getIssueFn = linear.getIssue,
    launchCmux: launchCmuxFn = launchCmuxSession,
    runJobFn = null, // lazily required below (bsc-runner.js) — test seam
    // cmux + ledger I/O — injectable test seams, same naming convention
    // bsc-next.js's own main() uses for the identical guards (findLiveWorkspaceForTask
    // et al are pure over whatever these return, so no other seam is needed).
    cmuxAvailable: cmuxAvailableFn = cmuxws.cmuxAvailable,
    listWorkspaces: listWorkspacesFn = cmuxws.listWorkspaces,
    isDoneTitle: isDoneTitleFn = cmuxws.isDoneTitle,
    claudeAliveIn: claudeAliveInFn = cmuxws.claudeAliveIn,
    terminalSurfaceAliveIn: surfaceAliveInFn = cmuxws.terminalSurfaceAliveIn,
    readLedgerEntries: readLedgerEntriesFn = dispatchLedger.readEntries,
    appendLedgerEntry: appendLedgerEntryFn = dispatchLedger.appendEntry,
    // BRO-278: same test-seam convention — real git I/O by default,
    // injectable so tests exercise workBranchCollisionGuard's refusal
    // without shelling out to git in this repo.
    listWorkBranchStatuses: listWorkBranchStatusesFn = listWorkBranchStatuses,
    // Cross-task/cross-system overlap check (task #1696) I/O seams — same
    // convention as the rest of this list: real implementation by default,
    // injectable so tests never make a live Linear API call or read this
    // machine's actual ~/.claude/tasks mirror (this file's sibling test,
    // tests/unit/linear-next.test.mjs, states "no live Linear API calls" as
    // an explicit invariant).
    listOpenIssuesWithDescriptions: listOpenIssuesWithDescriptionsFn = linear.listOpenIssuesWithDescriptions,
    loadNotionMirrorTasks: loadNotionMirrorTasksFn = loadNotionMirrorTasks,
    // Task #1898: injectable so tests can simulate "another attempt already
    // holds this issue's claim" without touching the real filesystem dir.
    acquireDispatchClaim: acquireDispatchClaimFn = (id, opts) => acquireClaim(DISPATCH_CLAIM_DIR, id, opts),
    releaseDispatchClaim: releaseDispatchClaimFn = (id) => releaseClaim(DISPATCH_CLAIM_DIR, id),
    // BRO-287: reportDispatchOnIssue()'s own Linear client, threaded through
    // so a successful dispatch in a test never falls through to the real
    // network client — closes the same "no live Linear API calls" gap the
    // comment above already claims for this file (a --force/cmux-success
    // test path was calling the real getTeam/getIssue/createComment/
    // updateIssue with no override before this was added).
    linear: reportLinearFn = linear,
  } = deps;

  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const args = parseArgs(argv);

  if (args.list) { await runList(); return; }

  if (!args.id || typeof args.id !== 'string') {
    console.error('[linear-next] --id <identifier> or --list is required (e.g. --id BRO-123).');
    console.error(USAGE);
    process.exit(1);
  }
  const identifier = String(args.id).trim().toUpperCase();
  if (!/^[A-Z]+-\d+$/.test(identifier)) {
    console.error(`[linear-next] "${args.id}" doesn't look like a Linear issue identifier (expected e.g. BRO-123).`);
    process.exit(1);
  }

  let issue;
  try {
    issue = await getIssueFn(identifier);
  } catch (e) {
    console.error(`[linear-next] Linear fetch failed for ${identifier}: ${e.message}`);
    process.exit(1);
  }
  if (!issue) {
    console.error(`[linear-next] ${identifier} not found.`);
    process.exit(1);
  }

  const taskId = ledgerTaskId(issue.identifier);
  const pseudoTask = { id: taskId, subject: `${issue.identifier} ${issue.title}`, description: issue.description || '' };
  const explicitModel = typeof args.model === 'string' ? args.model : null;
  // resolveModel's task/card shape is generic ({description, ...} / {notes,
  // ...}) — reused as-is (an issue description carries the same "Model: Opus"
  // hint-line convention a Notion card's notes would) rather than
  // re-implementing the same 3 resolution layers for Linear.
  const model = resolveModel({ explicitFlag: explicitModel, task: { description: issue.description }, card: null, notionId: null });
  const project = projectOf({ tags: ld.issueLabelNames(issue).join(','), category: null, subject: issue.title });
  // --tab always wins over --headless (explicit local override), matching
  // the flag-precedence CLAUDE.md rule 5's "caller states intent explicitly"
  // convention elsewhere in this codebase.
  const wantsHeadless = !!args.headless && !args.tab;
  const routing = ld.decideRouting(issue, { headless: wantsHeadless });
  const seed = ld.buildLinearSeed({
    identifier: issue.identifier, title: issue.title, description: issue.description,
    url: issue.url, model, project, mode: routing.mode,
  });

  // Cross-task/cross-system overlap check (task #1696, the #917/#1672 class
  // extended to the Linear side): findLiveWorkspaceForTask further below only
  // ever catches a SECOND dispatch of THIS SAME issue — it has no way to
  // catch a DIFFERENT Linear issue, or a Notion-mirror task, whose notes
  // describe the same underlying work. See buildOverlapComparisonPool /
  // checkLinearOverlapGuards above for the pool + guard wiring (reuses
  // dispatch-guards.js's exactTitleOverlapGuard + sessionTrackingCloneGuard
  // unchanged — no new guard logic, matching task #1672's own suggested
  // approach). Defined as a local closure (not called yet) so it can run in
  // BOTH the --dry-run/--print-prompt preview branch below AND the normal
  // launch path AFTER the terminal-state guard/kill switch (second-opinion
  // review, task #1696: a Done/Canceled issue or a LINEAR_NEXT_DISABLED=1 run
  // should refuse on THAT cheaper, more specific reason first, not burn a
  // live paginated Linear fetch deciding whether it's also a duplicate) — but
  // --dry-run must still preview it (bsc-next.js's own "runs before the
  // dry-run bail" contract), and this file's dry-run branch returns before
  // ever reaching the terminal-state guard.
  async function runOverlapCheck() {
    try {
      const openIssuesWithDesc = await listOpenIssuesWithDescriptionsFn();
      const notionMirrorTasks = loadNotionMirrorTasksFn();
      const pool = buildOverlapComparisonPool(openIssuesWithDesc, notionMirrorTasks, issue.identifier);
      // Bare issue.title, NOT pseudoTask.subject: the pool's title fields
      // (both the Linear and Notion-mirror halves) are unprefixed, but
      // pseudoTask.subject carries the "<identifier> <title>" launch-title
      // prefix (used for cmux/workspace matching elsewhere in this file) —
      // comparing that prefixed form against unprefixed pool titles would
      // make normalizeTitle() never match even a byte-for-byte duplicate.
      const overlapTarget = { id: taskId, subject: issue.title, description: issue.description || '' };
      const { refusal, warnings } = checkLinearOverlapGuards(overlapTarget, pool, args);
      if (refusal) { console.error(`[linear-next] ${refusal}`); process.exit(1); }
      warnings.forEach((w) => console.error(`[linear-next] WARNING: ${w}`));
    } catch (e) { console.error(`[linear-next] WARN overlap check failed (continuing): ${e.message}`); }
  }

  if (args['dry-run'] || args['print-prompt']) {
    // The guards themselves self-exempt the hard refusal under
    // --dry-run/--print-prompt/--force, so this only ever surfaces the
    // non-blocking warnings — never a process.exit — matching bsc-next.js's
    // "--dry-run previews the overlap check too" contract.
    await runOverlapCheck();
    console.log(`# would launch (${routing.mode} — ${routing.reason}) on: ${identifier} ${issue.title}\n`);
    console.log(seed);
    return;
  }

  // Terminal-state guard (task #1517, BRO-247 incident root cause): refuse
  // outright rather than silently self-healing through the archive dance
  // (task #1510) every time. Checked after --dry-run/--print-prompt (which
  // stay side-effect-free previews even for a terminal issue — matching
  // bsc-next.js's completedLaunchGuard, which self-exempts the same two
  // flags, and this file's own documented "--list/--dry-run still work"
  // kill-switch contract) but before every other launch gate below — an
  // already-Done/Canceled issue should never reach the verify/idempotency
  // gates that assume a live, dispatchable issue.
  if (!args.force) {
    const terminalRefusal = ld.checkTerminalStateGuard(issue);
    if (terminalRefusal) {
      console.error(`[linear-next] ${terminalRefusal}`);
      process.exit(1);
    }
  }

  // Kill switch (task #1303 plan review item 3): refuses ALL dispatch,
  // checked after --dry-run/--print-prompt (which stay side-effect-free
  // previews) but before every other gate — a session that hits this should
  // learn "the dispatcher is off" first, not "no verify command".
  if (process.env.LINEAR_NEXT_DISABLED === '1') {
    console.error('[linear-next] LINEAR_NEXT_DISABLED=1 — this dispatcher is switched off (cmux and headless both); rerun once it is re-enabled.');
    process.exit(1);
  }

  // Mirror-staleness dispatch claim (task #1898, parity with bsc-next.js's
  // task #1896 fix — see that file's own claim block for the full race
  // analysis and dispatchClaimGuard's header in dispatch-guards.js). Placed
  // after the terminal-state guard and kill switch above (both read freshly-
  // fetched live state, not a stale local mirror, so they're not part of the
  // race and gain nothing from running after the claim) but before every
  // guard below that DOES read a locally-cached snapshot (the overlap check,
  // idempotency, parked, dead-dispatch/duplicate-tab) — a second
  // linear-next.js process racing on this SAME issue is refused here instead
  // of independently passing every guard below on an equally stale snapshot.
  // Keyed on the bare `identifier` (e.g. "BRO-123"), not the ledger-
  // namespaced `taskId` ("linear:BRO-123") — dispatchClaimGuard's refusal
  // text prints `#${task.id}` verbatim, and this file's own top-level
  // refusals (terminal-state, kill switch, idempotency's console lines)
  // already print the bare identifier that way; the `linear:` prefix exists
  // to avoid collision in the SHARED dispatch-ledger.jsonl (and the guards
  // imported from dispatch-guards.js that build messages from pseudoTask.id
  // still print the namespaced form — that's pre-existing, unrelated to this
  // claim), which DISPATCH_CLAIM_DIR (a separate directory from bsc-next.js's
  // own) doesn't need.
  // `dispatchConfirmed` guards the process.on('exit', ...) release below —
  // set true only at this issue's two real dispatch-success points (the
  // headless branch once a job is actually spawned, and the cmux `res.ok`
  // branch) so the claim survives long enough to block a near-simultaneous
  // second success, while any guard refusal or failed launch after claiming
  // releases immediately so a legitimate same-session retry isn't blocked
  // for the full staleMs window.
  //
  // process.on('exit', ...) rather than try/finally, matching bsc-next.js's
  // identical reasoning: this file has many process.exit(1) calls between
  // here and the launch branches below, and process.exit() skips pending
  // finally blocks — process.on('exit', cb) is a DIFFERENT mechanism, run
  // synchronously as an explicit part of process.exit()'s own implementation
  // (the standard idiom lock-file libraries use for exactly this reason), so
  // it needs no changes to any existing guard's exit sites.
  let dispatchConfirmed = false;
  if (!args.force && !args['dry-run'] && !args['print-prompt']) {
    const claimResult = acquireDispatchClaimFn(identifier, { staleMs: DISPATCH_CLAIM_STALE_MS });
    const claimErr = dispatchClaimGuard({ id: identifier }, claimResult, args);
    if (claimErr) { console.error(`[linear-next] ${claimErr}`); process.exit(1); }
    if (claimResult === true) {
      process.on('exit', () => { if (!dispatchConfirmed) releaseDispatchClaimFn(identifier); });
    }
  }

  await runOverlapCheck();

  // Verify gate (mirrors bsc-next.js's dispatch gate exactly): a Linear
  // issue's description carries its own "## Acceptance criteria" section by
  // the same convention a Notion card's notes would, so evaluateVerifiability
  // (scripts/lib/autonomous-verify-cmd.js's SECTION_RE) needs no Linear-
  // specific parsing. Unlike bsc-next.js there is no "truncated mirror"
  // degraded path here — linear.getIssue() always returns the FULL
  // description, so an unarmed card always refuses outright rather than
  // warning.
  const gate = evaluateVerifiability(issue.description || '');
  if (!gate.cmd && !gate.ownerJudgment && !args['allow-unverifiable']) {
    console.error(`[linear-next] REFUSING to dispatch ${identifier}: no runnable verify command (${gate.reason}).`);
    console.error(`  The nightly acceptance recheck can only verify Done work by re-running a command captured at dispatch.`);
    console.error(`  Fix one of:`);
    console.error(`    1. Add a backticked safe-form command to the issue's "## Acceptance criteria" section.`);
    console.error(`    2. Add "VERIFY: owner-judgment" to the issue if this outcome cannot be machine-checked.`);
    console.error(`    3. Re-run with --allow-unverifiable to dispatch anyway (recorded in the ledger).`);
    process.exit(1);
  }

  // Idempotency (task #1303 plan review item 4) — two independent "this
  // already looks dispatched" signals, checked before any launch attempt.
  // See linear-dispatch.js's findUnresolvedDispatchComment/hasLiveLedgerEntry
  // for why both exist (cross-machine vs. host-local).
  const entries0 = readLedgerEntriesFn();
  if (!args.force) {
    const priorComment = ld.findUnresolvedDispatchComment(issue);
    const liveLedger = ld.hasLiveLedgerEntry(taskId, entries0);
    if (priorComment || liveLedger) {
      console.error(`[linear-next] REFUSING to dispatch ${identifier}: it already looks dispatched.`);
      if (priorComment) console.error(`  Linear comment: "${priorComment.body}" (${priorComment.createdAt})`);
      if (liveLedger) console.error(`  Local dispatch ledger has a live (non-dead, non-finished) entry for ${taskId}.`);
      console.error(`  Re-run with --force if you know this is stale.`);
      process.exit(1);
    }
  }

  // Parked (owner closed the tab without marking it done) — refuse a blind
  // re-dispatch, same as bsc-next.js. --force is the unpark.
  if (!args.force) {
    try {
      const parkErr = parkedGuard(pseudoTask, entries0, args, CLI_NAME);
      if (parkErr) { console.error(`[linear-next] ${parkErr}`); process.exit(1); }
    } catch (e) { console.error(`[linear-next] park check failed (continuing): ${e.message}`); }
  }

  // Cross-session work-branch collision guard (BRO-278, card #1281's A5 port
  // — see docs/dispatcher-safety-port-table.md). Mirrors bsc-next.js's own
  // call site: runs unconditionally (not gated on cmuxAvailableFn(), like the
  // cmux duplicate-tab check below) because local git state exists
  // independent of cmux, and both routing modes continue past this point
  // with no other check of local branch state. --dry-run/--print-prompt skip
  // the git I/O itself, not just the refusal, so a "dry" preview never
  // shells out.
  if (!args.force && !args['dry-run'] && !args['print-prompt']) {
    let branchStatuses = null;
    try {
      branchStatuses = listWorkBranchStatusesFn(taskId, { repoDir: REPO });
    } catch (e) {
      console.error(`[linear-next] WARN worktree-branch collision check failed (continuing): ${e.message}`);
    }
    if (branchStatuses) {
      const branchErr = workBranchCollisionGuard(pseudoTask, branchStatuses, args);
      if (branchErr) { console.error(`[linear-next] ${branchErr}`); process.exit(1); }
    }
  }

  // Dead-dispatch self-heal (both routing modes — task-level, not mode-
  // specific) + duplicate-cmux-tab guard. The duplicate-tab check below runs
  // for --headless too, on purpose: bsc-runner's cross-dispatcher lease
  // (bsc-runner.js's acquireLease()) is keyed by taskId ONLY and only ever
  // sees OTHER headless jobs — it is blind to a live cmux TAB on the same
  // task. bsc-next.js's own --headless branch keeps this exact
  // findLiveWorkspaceForTask check for precisely that reason (ship-check
  // Codex blocker, see bsc-next.js's --headless block comment) — skipping it
  // here for headless would silently reopen that same duplicate-dispatch
  // hole a headless Linear dispatch has no other guard against.
  if (cmuxAvailableFn()) {
    let workspaces = null;
    try { workspaces = listWorkspacesFn(); } catch (e) { console.error(`[linear-next] workspace list failed (continuing): ${e.message}`); }
    if (workspaces) {
      try {
        const { freshDead, refusal } = checkDeadDispatch(
          pseudoTask, workspaces, readLedgerEntriesFn(),
          isDoneTitleFn, claudeAliveInFn, surfaceAliveInFn, args,
        );
        freshDead.forEach((b) => { try { appendLedgerEntryFn(b); } catch (e) { console.error(`[linear-next] WARN ledger self-heal write failed for ${b.workspaceRef}: ${e.message}`); } });
        if (refusal) { console.error(`[linear-next] ${refusal}`); process.exit(1); }
      } catch (e) { console.error(`[linear-next] dead-dispatch check failed (continuing): ${e.message}`); }

      if (!args.force) {
        try {
          const dup = findLiveWorkspaceForTask(pseudoTask, workspaces, isDoneTitleFn);
          if (dup) {
            console.error(`[linear-next] a live workspace already matches ${identifier}: ${dup.ref} "${dup.title}".`);
            console.error(`  Another session may be on this issue. Check it (cmux read-screen --workspace ${dup.ref}),`);
            console.error(`  or re-run with --force to launch a second workspace anyway.`);
            process.exit(1);
          }
        } catch (e) { console.error(`[linear-next] duplicate check failed (continuing): ${e.message}`); }
      }
    }
  }

  // Human-gate refusal (mirrors bsc-next.js's --headless block exactly, task
  // #1004 class): "can this issue's outcome be CHECKED" (the verify gate
  // above) is a different question from "can an UNATTENDED session FINISH
  // it" — a headless job that completes and then stalls at an owner-only
  // gate (visual-qa approval, an async wait) strands cost with nothing to
  // show. Refusing here costs nothing; the issue is still dispatchable to a
  // cmux tab where the owner is present.
  if (routing.mode === 'headless' && !args['allow-human-gated']) {
    const hg = classifyHeadlessDispatchability({ subject: issue.title, notes: issue.description }, { verifyCmd: gate.cmd });
    if (!hg.dispatchable && hg.blockers.some((b) => b.code !== HEADLESS_BLOCKERS.NO_VERIFY_CMD)) {
      console.error(`[linear-next] REFUSING headless dispatch of ${identifier}: an unattended session cannot finish this issue.`);
      for (const b of hg.blockers) console.error(`    ${b.code}: ${b.detail}`);
      console.error(`  Dispatch it to a cmux tab instead (drop --headless), where the owner is present to clear the gate,`);
      console.error(`  or re-run with --allow-human-gated if you know the gate does not apply.`);
      process.exit(1);
    }
  }

  // Every dispatch attempt gets one correlationId, threaded into the ledger
  // entry AND the Linear comment — the cross-reference a human or a future
  // audit script uses to tie the two together (see buildDispatchComment's
  // header). Generated once, here, so both write paths (ledger, comment) use
  // the identical value for the SAME attempt.
  const correlationId = ld.generateCorrelationId();

  if (routing.mode === 'headless') {
    const { runJob } = runJobFn ? { runJob: runJobFn } : require('./lib/bsc-runner.js');
    console.log(`[linear-next] headless job starting on ${identifier}: ${issue.title} (model ${model}, correlation ${correlationId})`);
    // Ledger write happens BEFORE the job even starts (matches bsc-next.js's
    // own --headless ordering) — the leftmost half of the crash-safety
    // ordering this file's header describes: the ledger is the durable
    // record of intent, written before anything that could fail partway.
    try {
      appendLedgerEntryFn({
        event: 'launch', taskId, subject: pseudoTask.subject, workspaceRef: `headless:${taskId}`,
        model, verifyCmd: gate.cmd, verifyReason: gate.reason,
        allowUnverifiable: (!gate.cmd && args['allow-unverifiable']) || null,
        notionId: null, linearId: issue.identifier, correlationId,
      });
    } catch (e) { console.error(`[linear-next] WARN ledger launch write failed (non-fatal): ${e.message}`); }

    // killSwitchEnv: this dispatcher answers to LINEAR_NEXT_DISABLED only —
    // BSC_RUNNER_DISABLED (the retired Notion-loop's plist switch, #1311)
    // must not gate the Linear path at the runner level (BRO-286).
    const res = await runJob({ taskId, subject: pseudoTask.subject, prompt: seed, model, isolate: true, killSwitchEnv: 'LINEAR_NEXT_DISABLED' });
    if (res.stage === 'lease-held') {
      console.error(`[linear-next] ${identifier} already has a live headless job (${(res.holder && res.holder.jobId) || 'unknown'}). Use bsc-status to inspect.`);
      process.exitCode = 1;
      return;
    }
    if (res.stage === 'disk-pressure') {
      // BRO-2319: same "nothing was actually spawned" shape as lease-held —
      // dispatchConfirmed must stay false so the claim releases immediately
      // and a retry once disk pressure clears isn't blocked for the full
      // staleMs window.
      console.error(`[linear-next] ${identifier} dispatch refused: disk pressure. Retry once GC/disk clears.`);
      process.exitCode = 1;
      return;
    }
    // Task #1898: only NOW (not before runJob() was even called) is this a
    // real dispatch — 'lease-held' above means nothing was actually spawned,
    // and the dispatch claim must release immediately in that case rather
    // than sit held for the full staleMs window blocking a legitimate retry.
    dispatchConfirmed = true;
    console.log(`[linear-next] headless job ${res.jobId} ${res.ok ? 'DONE' : `FAILED (${res.stage})`}`);
    if (res.logFile) console.log(`  log: ${res.logFile}`);
    if (!res.ok) { process.exitCode = 1; return; }
    // Issue-side write happens AFTER the durable ledger write above, per the
    // header's crash-safety ordering — a crash between them leaves the
    // ledger (not the issue thread) as the authoritative "this was
    // dispatched" record, and hasLiveLedgerEntry() still catches it on retry.
    await reportDispatchOnIssue(issue, res.jobId, 'headless', correlationId, { linear: reportLinearFn });
    return;
  }

  // cmux tab path
  const title = buildAutoTitle({ subject: pseudoTask.subject, project, model });
  const res = launchCmuxFn({
    title, seed, seedKey: taskId.replace(/[^a-zA-Z0-9-]/g, '_'), cwd: REPO, model,
    focus: true, autoColor: !!project,
    // Task #1904: --force must actually reach the terminal-capacity preflight
    // — it is the documented escape hatch from a ceiling learned too low, and
    // the refusal message advertises it. It does NOT weaken the reclaim or
    // liveness checks; see launchCmuxSession's @param note.
    force: !!args.force,
    // Same launch-verification budget bsc-next.js uses (card #503/#705): 90s
    // for the typed command to start, 360s slow-boot cap, 60s late-adopt
    // grace. NOT re-tuned here — this is the same primitive, same host.
    verifyTimeoutSec: 90, lateAdoptSec: 60, slowBootCapSec: 360,
  });

  if (!res.ok && res.refusedForCapacity && !res.workspaceRef) {
    // Task #1904: a REFUSAL, not a failure. cmux is at its terminal-runtime
    // ceiling, so nothing was created — there is no workspace to journal and
    // no dead attempt to burn against this issue.
    console.error(`[linear-next] LAUNCH REFUSED — ${res.reason}`);
    console.error(`  Nothing was created for ${identifier}. Past this ceiling cmux opens the workspace and accepts the`);
    console.error('  command but never attaches a terminal, so the command can never run there.');
    console.error(`    node scripts/linear-next.js --id ${identifier} --headless   # needs no cmux terminal (0 dead in 158 launches)`);
    console.error('    node scripts/bsc-prune.js                                    # owner-run: close finished tabs to free a runtime');
    try {
      appendLedgerEntryFn({
        // 'launch-refused', not 'launch-failed' — see bsc-next.js's identical
        // branch: 'launch-failed' is a START_EVENT in
        // audit-archived-in-progress.js, and nothing started here.
        event: 'launch-refused', taskId, subject: pseudoTask.subject, workspaceRef: null, model,
        failureReason: res.reason, refusedForCapacity: true, liveRuntimes: res.liveRuntimes ?? null,
        terminalCeiling: res.terminalCeiling ?? null, linearId: issue.identifier, correlationId,
      });
    } catch (e) { console.error(`[linear-next] WARN ledger write failed (non-fatal): ${e.message}`); }
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`[linear-next] LAUNCH NOT VERIFIED (${res.reason}).`);
    try {
      const failedEntries = dispatchLedger.failedLaunchEntries({
        taskId, subject: pseudoTask.subject, workspaceRef: res.workspaceRef, model,
        verifyCmd: gate.cmd, verifyReason: gate.reason,
        failureReason: res.reason, deadConfirmed: res.deadConfirmed !== false,
      });
      failedEntries.forEach((e) => appendLedgerEntryFn({ ...e, linearId: issue.identifier, correlationId }));
    } catch (e) { console.error(`[linear-next] WARN ledger dead write failed (non-fatal): ${e.message}`); }
    if (res.workspaceRef) console.error(`  workspace: ${res.workspaceRef} (left open for inspection)`);
    console.error(`  command that should have run:`);
    console.error(`  ${res.command}`);
    process.exit(1);
  }

  // Task #1898: this is a real dispatch — hold the claim (let it expire via
  // staleMs) instead of releasing on exit, so a near-simultaneous second
  // dispatch attempt still sees it held.
  dispatchConfirmed = true;
  console.log(`[linear-next] opened Cmux tab "${title}" (${res.ref}) on ${identifier} (claude verified running${res.adoptedLate ? ', adopted after a late start' : ''}, correlation ${correlationId})`);
  // Ledger write BEFORE the Linear comment/state mutation — see this file's
  // header for why (crash-safety: a crash here still leaves a live ledger
  // entry a retry's hasLiveLedgerEntry() check will find).
  try {
    appendLedgerEntryFn({
      event: 'launch', taskId, subject: pseudoTask.subject, workspaceRef: res.ref, model,
      verifyCmd: gate.cmd, verifyReason: gate.reason,
      allowUnverifiable: (!gate.cmd && args['allow-unverifiable']) || null,
      notionId: null, adoptedLate: res.adoptedLate || null, linearId: issue.identifier, correlationId,
      // Task #1904 — see bsc-next.js's identical field for why the live cmux
      // terminal-runtime count is worth carrying on every launch row.
      liveRuntimes: res.liveRuntimes ?? null,
    });
  } catch (e) { console.error(`[linear-next] WARN ledger write failed (non-fatal): ${e.message}`); }

  await reportDispatchOnIssue(issue, res.ref, 'cmux', correlationId, { linear: reportLinearFn });
}

if (require.main === module) {
  main().catch((e) => { console.error(`[linear-next] fatal: ${e.stack || e.message}`); process.exit(1); });
}

module.exports = {
  parseArgs, ledgerTaskId, runList, main, USAGE,
  // Task #1696: pure overlap-guard wiring, exported for
  // scripts/tests/linear-next-overlap-guards.test.mjs (CLAUDE.md rule 15 —
  // the test require()s these real functions rather than restating them).
  buildOverlapComparisonPool, checkLinearOverlapGuards, loadNotionMirrorTasks, TASKS_DIR,
  // BRO-287: exported so tests/unit/linear-next.test.mjs can drive its
  // {nodes}-shape state normalization via the injected `deps.linear` seam
  // without a live Linear API call.
  reportDispatchOnIssue,
};
