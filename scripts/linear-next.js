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

require('./lib/load-env').loadEnv();

const linear = require('./lib/linear-client.js');
const ld = require('./lib/linear-dispatch.js');
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
} = require('./lib/dispatch-guards.js');

// Hardcoded, not __dirname-relative: this script is routinely run from
// inside a worktree (this session included), and a relative REPO would
// resolve into that worktree's own tree instead of the canonical checkout —
// the same fix dispatch-ledger.js and bsc-next.js already apply to their own
// REPO constants, for the same reason (their header comments explain why).
const REPO = '/Users/tompryor/Broadwayscore';

const CLI_NAME = 'scripts/linear-next.js';

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
async function reportDispatchOnIssue(issue, ref, mode, correlationId) {
  try {
    const body = ld.buildDispatchComment({ ref, ts: new Date().toISOString(), mode, correlationId });
    await linear.createComment(issue.id, body);
  } catch (e) { console.error(`[linear-next] WARN could not post dispatch comment on ${issue.identifier}: ${e.message}`); }
  try {
    const team = await linear.getTeam();
    const stateList = Array.isArray(team.states) ? team.states : (team.states && team.states.nodes) || []; // getTeam() returns the GraphQL {nodes} connection shape (same class as linear-issue-create's 2026-08-12 fix)
    const started = stateList.find((s) => s.type === 'started');
    if (!started) { console.error(`[linear-next] WARN no 'started'-type workflow state on team ${linear.TEAM_KEY} — leaving ${issue.identifier}'s state unchanged`); return; }
    await linear.updateIssue(issue.id, { stateId: started.id });
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
  const pseudoTask = { id: taskId, subject: `${issue.identifier} ${issue.title}` };
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

  if (args['dry-run'] || args['print-prompt']) {
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
    console.log(`[linear-next] headless job ${res.jobId} ${res.ok ? 'DONE' : `FAILED (${res.stage})`}`);
    if (res.logFile) console.log(`  log: ${res.logFile}`);
    if (!res.ok) { process.exitCode = 1; return; }
    // Issue-side write happens AFTER the durable ledger write above, per the
    // header's crash-safety ordering — a crash between them leaves the
    // ledger (not the issue thread) as the authoritative "this was
    // dispatched" record, and hasLiveLedgerEntry() still catches it on retry.
    await reportDispatchOnIssue(issue, res.jobId, 'headless', correlationId);
    return;
  }

  // cmux tab path
  const title = buildAutoTitle({ subject: pseudoTask.subject, project, model });
  const res = launchCmuxFn({
    title, seed, seedKey: taskId.replace(/[^a-zA-Z0-9-]/g, '_'), cwd: REPO, model,
    focus: true, autoColor: !!project,
    // Same launch-verification budget bsc-next.js uses (card #503/#705): 90s
    // for the typed command to start, 360s slow-boot cap, 60s late-adopt
    // grace. NOT re-tuned here — this is the same primitive, same host.
    verifyTimeoutSec: 90, lateAdoptSec: 60, slowBootCapSec: 360,
  });

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
    });
  } catch (e) { console.error(`[linear-next] WARN ledger write failed (non-fatal): ${e.message}`); }

  await reportDispatchOnIssue(issue, res.ref, 'cmux', correlationId);
}

if (require.main === module) {
  main().catch((e) => { console.error(`[linear-next] fatal: ${e.stack || e.message}`); process.exit(1); });
}

module.exports = { parseArgs, ledgerTaskId, runList, main, USAGE };
