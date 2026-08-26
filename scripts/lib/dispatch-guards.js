/**
 * dispatch-guards.js — the shared pre-launch guard/gate predicates every
 * dispatcher (bsc-next.js for Notion-mirror tasks, linear-next.js for Linear
 * issues) must run before opening a workspace. Extracted out of bsc-next.js
 * (task #1303 plan review, 2026-08-12) so a second dispatcher never
 * re-derives — and inevitably drifts from — these refusals. bsc-next.js
 * re-exports every name below for back-compat; this file is what makes its
 * Notion-mirror path deletable later without taking the guards with it.
 *
 * NOT byte-for-byte verbatim (ship-check finding, ci = false claim caught):
 * the logic in every function is unchanged, but two return strings were
 * deliberately generalized for a second, non-bsc-next caller —
 *   - parkedGuard()'s escape-hatch line now takes a `cliName` param
 *     (defaults to bsc-next.js's own invocation, preserving its exact
 *     pre-extraction text — bsc-next.test.mjs asserts on it byte-for-byte);
 *     linear-next.js passes its own script name so the printed command is
 *     actually runnable for the dispatcher that hit the guard.
 *   - staleOutcomeGuard()'s Notion remediation line is now conditional on
 *     notionIdOf(task) actually finding a `[notion:<uuid>]` tag, instead of
 *     always printing `--status Done <pid>` with pid=null for a caller (a
 *     Linear pseudoTask) that never carries one.
 * Both call sites also lost their hardcoded `[bsc-next] ` message prefix —
 * callers prepend their own (bsc-next.js and linear-next.js both already
 * did this at their call sites before the extraction).
 *
 * Six guards, two families:
 *   - DUPLICATE / DEAD / PARKED (workspace-shaped): findLiveWorkspaceForTask,
 *     deadDispatchGuard, checkDeadDispatch, parkedGuard. Pure over
 *     {task, ledgerEntries/workspaces, opts} — no I/O, callers own the
 *     dispatch-ledger.js reads and the process.exit().
 *   - VERIFIABILITY (card-text-shaped): staleOutcomeGuard (pure), plus
 *     evaluateVerifiability/classifyHeadlessDispatchability re-exported here
 *     from their own leaf modules (verify-gate.js / headless-dispatchability.js)
 *     so both dispatchers have ONE require() line for all six.
 *
 * All six historically read Notion-shaped fields (task.description carrying
 * a `[notion:<uuid>]` tag, card.notes/card.outcome) — that is a convention
 * of the CALLER's task/card shape, not something these functions assume.
 * Nothing here requires a Notion id to be present; notionIdOf() and
 * staleOutcomeGuard()'s remediation text simply degrade to a null/absent pid
 * for a caller (e.g. linear-next.js's pseudoTask) that never carries one.
 *
 * @typedef {object} DispatchGuardTask
 * @property {string|number} id       - dispatch-ledger taskId (bsc-next: a
 *                                       bare task-mirror number; linear-next:
 *                                       the namespaced `linear:BRO-123` form)
 * @property {string} subject         - human title, matched against live
 *                                       workspace titles (findLiveWorkspaceForTask)
 *                                       and echoed into refusal messages
 * @property {string} [description]   - free text; notionIdOf() looks for an
 *                                       embedded `[notion:<uuid>]` tag here,
 *                                       absent for non-Notion callers
 * @property {string} [status]        - 'pending'|'in_progress'|'completed'
 *                                       (only completedLaunchGuard, still in
 *                                       bsc-next.js, reads this)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const dispatchLedger = require('./dispatch-ledger.js');
const cmuxws = require('./cmux-workspaces.js');
// gitSafeJobId for matchesTaskWorkBranch's git-ref sanitization (BRO-278);
// readLease/pidLooksLikeClaude for sessionAliveForTask (BRO-268) — the
// per-task lease file bsc-runner.runJob() writes/updates with the live pid,
// independent of any cmux workspace. Same require direction
// scripts/backlog-drain.js already uses for the same reason; no cycle
// (bsc-runner.js's own requires — dispatch-ledger.js, claude-cli.js,
// worktree-gc-reclaim.js — never reach back to this file).
const { gitSafeJobId, readLease, pidLooksLikeClaude } = require('./bsc-runner.js');
const { evaluateVerifiability } = require('./verify-gate.js');
const { classifyHeadlessDispatchability, BLOCKERS: HEADLESS_BLOCKERS } = require('./headless-dispatchability.js');
const { parseRecheckAfter, parseRecheckAfterFromCard } = require('./recheck-stamp.js');
const { findOverlappingCards } = require('./dispatch-overlap-check.js');
// Pure leaf module (no requires of its own), so this cannot cycle back here.
const { TERMINAL_CARD_STATUSES } = require('./task-reclaim.js');

// scripts/linear-import.js's Notion-mirror <-> Linear-issue join (Phase 0
// rail 1, plan 2026-08-12). Default path only — linearMirrorGuard() itself
// takes the parsed mapping as a plain object, so tests never touch this path.
const LINEAR_MAPPING_PATH = path.join(__dirname, '..', '..', 'data', 'linear-import-mapping.json');

// Duplicate-dispatch guard: a live (non-✅) workspace whose title matches this
// task's launch title means a session is already on it — launching another
// splits the work (near-miss 2026-07-13: task #46 dispatched while
// workspace:37 was still open on it). Titles get activity-glyph prefixes in
// list output and may be truncated, so compare glyph-stripped prefixes.
function findLiveWorkspaceForTask(task, workspaces, isDone) {
  // titleMatchesSubject (dispatch-ledger.js) strips cmux's own activity-glyph
  // prefix (spinner/✳/etc — also eats the 🤖 auto-dispatch emoji, since it
  // isn't a letter/digit), THEN strips the "<Project>·" naming prefix (scope
  // add, card #168), so a live auto-dispatched workspace still matches its
  // raw task subject. Shared with the park-guard's renumber rematch (task
  // #883) so both guards agree on the same >=20-char bar — a drift between
  // them would make one see a match the other doesn't.
  return workspaces.find(w => !isDone(w.title) && dispatchLedger.titleMatchesSubject(w.title, task.subject)) || null;
}

// Refuse a blind re-dispatch once a task has died DEAD_ATTEMPT_LIMIT times
// without ever being verified alive again (task #334: task #297 got a 3rd
// dead cmux workspace opened onto it with zero visibility into the 2 that
// already died). --force / --dry-run / --print-prompt bypass it, matching
// completedLaunchGuard's carve-outs.
function deadDispatchGuard(task, ledgerEntries, opts) {
  if (opts.force || opts['dry-run'] || opts['print-prompt']) return null;
  const cap = dispatchLedger.dispatchCapDecision(task.id, ledgerEntries);
  if (!cap.blocked) return null;
  if (cap.reason === 'infra') {
    const refs = cap.infra.map(d => d.workspaceRef).filter(Boolean).join(', ') || 'unknown refs';
    return `task #${task.id}'s cmux launch has failed to even start ${cap.infra.length}x in a row (dead workspaces: ${refs}) — ` +
      `every one of those is 'terminal surface never rendered', not a task failure. That many in a row with zero ` +
      `successful boots suggests cmux itself is wedged right now, not bad luck on this card. Bring cmux to the ` +
      `foreground (or restart it) before dispatching anything else. Re-run with --force to try again anyway.`;
  }
  const refs = cap.substantive.map(d => d.workspaceRef).filter(Boolean).join(', ') || 'unknown refs';
  return `task #${task.id} has died ${cap.substantive.length}x already without finishing (dead workspaces: ${refs}). ` +
    `Blind re-dispatch won't fix a task that keeps dying — investigate first: shrink the scope, escalate with ` +
    `--model opus, or route it through the Notion Action "Fix" pipeline (has its own capped-retry timeout ` +
    `handling — see task #289). Re-run with --force to dispatch anyway.`;
}

// Owner-close park (task #578). The duplicate-dispatch guard only fires while
// a matching workspace is STILL LISTED, so closing a tab used to hand the card
// straight back to the dispatcher — 17 launches in one day, 187 launch refs
// against 26 live workspaces (owner report 2026-08-02). bsc-prune records a
// 'vanished' breadcrumb for a tab that left the listing; this refuses to
// reopen it. Same signature/shape as deadDispatchGuard above: pure, returns a
// refusal string or null, and main() owns the exit.
//
// --force IS the unpark (its launch entry clears the park — see
// dispatchLedger.parkedTasks), so this can never become a state whose only
// escape is a flag nobody remembers.
//
// cliName defaults to bsc-next.js's own invocation (preserves the exact
// pre-extraction message byte-for-byte — bsc-next.test.mjs asserts on it) —
// linear-next.js passes its own script name so the printed escape hatch is
// actually runnable for the dispatcher that hit the guard.
function parkedGuard(task, ledgerEntries, opts, cliName = 'scripts/bsc-next.js') {
  if (opts.force || opts['dry-run'] || opts['print-prompt']) return null;
  const parked = dispatchLedger.parkedTasks(ledgerEntries).get(String(task.id));
  if (!parked) return null;
  return `task #${task.id} is parked: its workspace (${parked.workspaceRef}) was closed on ` +
    `${String(parked.ts || '').slice(0, 10)} without being marked done. Closing a tab means "stop working ` +
    `this card", so nothing re-dispatches it on its own.\n` +
    `  To resume it: node ${cliName} --id ${task.id} --force`;
}

// Stale-outcome guard (task #1272, the #383 class): a card whose Outcome
// PROPERTY already records completed work, with no acceptance criteria to
// verify a NEW attempt against, is DONE-BUT-NEVER-CLOSED — dispatching it
// redoes finished work instead of closing the card. Outcome is a separate
// property from Notes (notion-brain.js: `outcome: getRichTextValue(p.Outcome)`),
// so this fires even when card.notes itself is truncated/unavailable —
// unlike a verify-gate block that only refuses when the full card is in
// hand. That gap is exactly what let #383 slip through as an "unarmed" WARN
// instead of a refusal: its Outcome was filled, but nothing downstream of a
// WARN ever looks at card.outcome. A RECHECK-AFTER stamp (CLAUDE.md Session
// Discipline) is a legitimate, structured "revisit me" signal, not silent
// staleness, and is exempted. --force / --allow-unverifiable bypass it,
// matching the sibling guards' and the verify-gate's own override
// conventions.
//
// Native-task extension (task #1355): a native task (TaskCreate, no Notion
// mirror — card is null) has no Outcome property to read, so the check
// above was a total no-op for it even when task.status is already
// 'completed' — the exact same #383 class (done-but-never-closed), just
// spelled with a status field instead of a filled Outcome. task.status ===
// 'completed' is that native equivalent: a recorded statement the work is
// done. Gated strictly on `card == null` (not on outcome-emptiness) — a
// live Notion card with a blank Outcome is normal for an in-progress card
// and must never trip this; only the truly card-less native path does.
// RECHECK-AFTER keeps its exemption, read from task.description (the only
// text a native task carries) via the same parseRecheckAfter used on
// card fields. The 'armed' exemption deliberately does NOT extend to
// task.description: notion-tasks-sync truncates it to 400 chars (see
// bsc-next.js's fullCardInHand comment), so a verify command living past
// that cut would non-deterministically arm/disarm on truncation — unlike
// RECHECK-AFTER's short single-line stamp, which reliably survives.
function isNativeTaskDoneWithoutCard(task, card) {
  return card == null && !!task && task.status === 'completed';
}

// Deliberately separate from predispatch-guard.js's classifyCandidate (task
// #1816, owner decision 2026-08-19: keep both, do not merge). This guard
// catches ANY unverifiable filled Outcome regardless of shape; classifyCandidate's
// REOPEN-SUSPECT is a narrower subset (completedDate + a long outcome + a
// sha-shaped substring) built for a different signal (a falsely-reopened
// card, not merely a stale one) — a card can trip this guard without ever
// reaching REOPEN-SUSPECT. Both run back to back on the same card at
// bsc-next.js:1081-1098 (defense-in-depth, not alternate call paths) and
// together in predispatch-queue-audit.js:230/254 for advisory tallying.
function staleOutcomeGuard(task, card, opts) {
  if (opts.force || opts['allow-unverifiable'] || opts['dry-run'] || opts['print-prompt']) return null;
  const outcome = card && String(card.outcome || '').trim();
  const nativeCompleted = isNativeTaskDoneWithoutCard(task, card);
  if (!outcome && !nativeCompleted) return null;
  if (outcome && evaluateVerifiability((card && card.notes) || '').armed) return null;
  if (parseRecheckAfterFromCard(card)) return null;
  if (nativeCompleted && parseRecheckAfter(task.description) != null) return null;
  if (nativeCompleted) {
    return `REFUSING to dispatch #${task.id}: this native task is already marked completed (no Notion ` +
      `card backing it) — that status IS the recorded statement that the work is done, with no acceptance ` +
      `criteria to verify a new attempt against. This looks like the #383 class (done-but-never-closed), ` +
      `not a fresh dispatch.\n` +
      `  Fix one of:\n` +
      `    1. Leave it completed — there's nothing to dispatch.\n` +
      `    2. Add "RECHECK-AFTER: YYYY-MM-DD" to the task description if this needs a scheduled revisit.\n` +
      `    3. Re-run with --force (or --allow-unverifiable) to dispatch anyway (recorded in the ledger).`;
  }
  const pid = notionIdOf(task);
  return `REFUSING to dispatch #${task.id}: its card already has a filled Outcome (recorded ` +
    `completed work) and no acceptance criteria to verify a new attempt against. This looks like the #383 class ` +
    `(done-but-never-closed), not a fresh dispatch.\n` +
    `  Fix one of:\n` +
    `    1. Close the card as Done if the recorded Outcome is sufficient${pid ? ` (Notion): node scripts/notion-brain.js update ${pid} --status Done` : ''}.\n` +
    `    2. Add a backticked safe-form command to the card's "## Acceptance criteria" stating what's still missing.\n` +
    `    3. Re-run with --force (or --allow-unverifiable) to dispatch anyway (recorded in the ledger).`;
}

// ── Closed-card guard (task #1790, the stall-sweep half of the mirror problem) ──
// The local task mirror is NOT authoritative about whether a card is still
// open. `notion-tasks-sync.js pull` only teaches the mirror about cards it
// pulls, and a Done card drops out of that set entirely, so a card closed in
// Notion can sit at status 'in_progress' locally indefinitely.
// reconcileStaleMirrors (notion-tasks-sync.js:923) rotates through the
// backlog and eventually corrects each entry, but bsc-reconcile.js's stall
// sweep fires faster than rotation reaches any given entry — measured live
// 2026-08-18, a card closed at 20:08 was relaunched at 20:43 and pruned again
// at 20:45, twice inside 40 minutes.
//
// The fix belongs HERE rather than in the sweep because bsc-next.js already
// fetches the authoritative card on every dispatch (`fetchCardFn(pid)`, just
// above staleOutcomeGuard's call site) — so this costs ZERO extra Notion
// calls and covers every dispatcher at once: the stall sweep, a hand-run
// `--id`, digest-autofix, and the #853 dead-tab redispatch. Putting a second
// Notion client inside the sweep would have fixed exactly one caller.
//
// Deliberate scope decisions, each pinned by a test:
//   * `card == null` (the Notion fetch degraded) ALLOWS. This guard only ever
//     fires on a POSITIVE closed reading. A refusal-on-unknown would let a
//     Notion outage starve the sweep's 2-per-tick budget and block genuinely
//     stalled tasks from ever healing — and it matches bsc-next.js's existing
//     "refuse only when the full card is in hand" precedent.
//   * "Paused" is NOT closed. mapStatus (notion-tasks-sync.js:104-110) folds
//     Paused into the dispatchable 'pending' lane, so treating it as closed
//     would be a policy change about which cards are workable, not a
//     stale-mirror fix. This is not a fresh judgement call: task #1778 already
//     considered adding 'Paused' to the terminal pair and REJECTED it after
//     adversarial review (see notion-tasks-sync.js:48-55). Two reviewers of
//     THIS change argued the opposite; the prior decision stands, and reopening
//     it belongs on its own card rather than riding in on a mirror fix.
//   * Diverges deliberately from scripts/linear-next.js's checkTerminalStateGuard
//     (~:361), which DOES bypass on --force. That guard protects the Linear
//     lane, which has no --force-carrying reconciler aimed at it;
//     bsc-reconcile.js's redispatchArgv does exactly that here. Same intent,
//     different blast radius — do not "harmonise" the two without re-reading
//     redispatchArgv:176-178 first.
//   * `--force` does NOT bypass this. --force exists to override the
//     duplicate-workspace guard; a closed card is never something it should
//     override, and bsc-reconcile.js's #853 path (redispatchArgv:176-178) is
//     precisely where the stale-mirror bug also bites. The escape hatch is its
//     own explicit, ledger-visible flag, mirroring --allow-unverifiable.
// Reuses task-reclaim.js's TERMINAL_CARD_STATUSES ({Done, Archived,
// Cancelled}) rather than declaring a parallel set — notion-tasks-sync.js:44
// already reuses that same constant for the same "never make an
// Archived/Cancelled card dispatchable again" rule, and a second copy here is
// exactly the drift CLAUDE.md rule 15 warns about. A review caught the first
// version of this guard omitting Archived, which would have let a card whose
// STATUS PROPERTY reads "Archived" dispatch. Lowercased once, at module
// load, so the canonical set stays the single source of truth.
//
// This is NOT the same thing as a page moved to Notion's TRASH (task #1811).
// The "Archived" entry above matches the Status *property value* — a Select
// option a human sets. Trashing a page is a page-level action (the `archived`
// / `in_trash` API booleans, see formatCard()) that leaves the Status
// property completely untouched: a trashed page can still read "In
// progress" forever, so CLOSED_CARD_STATUSES never matches it, even though
// (as the comment above already correctly says) it refuses ALL Notion writes
// and so cannot even be corrected card-side. `card.archived` below is the
// check that actually catches that case; the two are deliberately checked
// independently rather than merged into one Set, since one is a status
// string and the other a page-level boolean with no status value to fake.
const CLOSED_CARD_STATUSES = new Set([...TERMINAL_CARD_STATUSES].map(s => s.toLowerCase()));

// Deliberately separate from predispatch-guard.js's classifyCandidate (task
// #1816, owner decision 2026-08-19: keep both, do not merge). The two DO
// overlap on the archived/trashed-page check (both read card.archived
// independently — see this file's header, "checked independently rather
// than merged into one Set"), but diverge everywhere else: this guard never
// treats 'Paused' as closed (a deliberate, previously-litigated choice — see
// the block comment above), while classifyCandidate's REVIEW_STATUSES groups
// Paused with Done on purpose; this guard also has no PARKED:-note check at
// all. Chained together at the same call sites (bsc-next.js:536-543 and
// :1088-1098), not routed to different callers — see predispatch-guard.js's
// own header for the fuller rationale and predispatch-guard.test.mjs for the
// parity/divergence coverage between the two.
function closedCardGuard(task, card, opts) {
  const o = opts || {};
  if (o['allow-closed-card'] || o['dry-run'] || o['print-prompt']) return null;
  if (!card) return null; // degraded fetch — honest unknown, never a refusal
  if (card.archived) {
    return `REFUSING to dispatch #${task.id}: its Notion card has been moved to the TRASH — the local task ` +
      `mirror still reads "${(task && task.status) || 'unknown'}", and the card's own Status property may still ` +
      `read anything (trashing doesn't touch it), but the page itself refuses every write ("Can't edit block ` +
      `that is archived"), so dispatching would open a session that can never even mark the card Done.\n` +
      `  Fix one of:\n` +
      `    1. Nothing — the work is done or abandoned. Close the local task mirror entry by hand: set status ` +
      `to "completed" (manuallyResolvedReason/manuallyResolvedAt alone do NOT remove it from the queue — ` +
      `actionable() only filters on status, not those fields) AND set manuallyResolvedReason + manuallyResolvedAt ` +
      `(so a later dead-completion reconciliation never tries to reopen it), since the trashed Notion card can't ` +
      `be updated to signal either.\n` +
      `    2. Restore the page from Notion's trash if there is genuinely more to do, then dispatch again.\n` +
      `    3. Re-run with --allow-closed-card to dispatch anyway (recorded in the ledger) — note predispatch-guard ` +
      `runs an independent archived check too, so a plain --allow-closed-card alone will still be refused there; ` +
      `add --allow-reopen-suspect as well to get past both.`;
  }
  const status = String(card.status || '').trim().toLowerCase();
  if (!CLOSED_CARD_STATUSES.has(status)) return null;
  const pid = notionIdOf(task);
  return `REFUSING to dispatch #${task.id}: its Notion card is already ${card.status} — the local task ` +
    `mirror still reads "${(task && task.status) || 'unknown'}", but Notion is the source of truth. ` +
    `\`notion-tasks-sync.js pull\` does reconcile the mirror, but only a bounded rotation window per run ` +
    `(reconcileStaleMirrors), so a freshly-closed card can stay stale locally for several runs — ` +
    `dispatching now would relaunch closed work.\n` +
    `  Fix one of:\n` +
    `    1. Nothing — the work is done. Re-run node scripts/notion-tasks-sync.js pull until the mirror catches up.\n` +
    `    2. Re-open the card if there is genuinely more to do${pid ? `: node scripts/notion-brain.js update ${pid} --status "In progress"` : ''}, then dispatch again.\n` +
    `    3. Re-run with --allow-closed-card to dispatch anyway (recorded in the ledger).`;
}

// Pure composition of the self-heal + refusal check (no I/O — the caller does
// the actual ledger append and process.exit). Split out so the burst scenario
// that motivated task #334 is directly unit-testable: waiting for a 'dead'
// breadcrumb that only bsc-prune.js writes (typically once/day) would let a
// same-SESSION burst of redispatches sail through, since no sweep runs
// between dispatch #2 dying and dispatch #3 launching (ship-check adversarial
// finding, 2026-07-22). Here the caller computes idle-and-unmarked itself,
// from the live cmux list, using the SAME predicate bsc-prune.js uses —
// dispatch #3 then sees dispatch #1 and #2's now-idle workspaces as fresh
// 'dead' breadcrumbs without needing a sweep in between.
//
// Card #564: claudeAliveInFn alone is the same single-signal trust that #559
// proved has a real false-negative mode (verified live, 2026-07-26: a
// workspace had claudeAliveIn() === false while visibly still running with an
// active Claude Code session). A false "idle" verdict here means a still-live
// workspace gets treated as a dead breadcrumb, self-healing deadDispatchGuard
// into green-lighting a SECOND dispatch onto a task someone is already
// working on. Same fix shape as #559's pruneDone: require the independent
// terminal-surface signal (surfaceAliveFn) to ALSO say not-alive before a
// workspace counts as idle-and-dead.
//
// BRO-268: even both workspace-shaped signals agreeing "not alive" can be
// wrong — they only see what's running inside THIS SPECIFIC cmux workspace's
// own pty, so a headless/resumed session (bsc-runner.js's runJob, launched
// via bsc-reconcile.js's retry/resume paths) doing the real work outside
// that pty is invisible to them. sessionAliveFn is the independent
// session-shaped signal: it reads bsc-runner's per-task lease file (written
// at spawn, live pid re-verified via pidLooksLikeClaude — sessionAliveForTask
// below) and says "alive" regardless of which workspace, if any, is
// currently associated with the task.
//
// When it says alive, this strips EVERY dead-shaped entry for task.id — not
// just this call's freshDead, but also any already sitting in the incoming
// ledgerEntries from earlier calls/sweeps — before handing off to
// deadDispatchGuard. Filtering freshDead alone would only stop the count
// from climbing further; deadDispatchGuard's dispatchCapDecision counts
// every dead-shaped row for task.id across the WHOLE array it's given
// (dispatch-ledger.js deadAttemptsForTask has no "fresh vs historical"
// concept), so a task that already reached DEAD_ATTEMPT_LIMIT from past
// (mistaken) breadcrumbs would otherwise stay refused forever even once its
// live session is provable. Scoped inside this function, not
// deadDispatchGuard's own signature — predispatch-queue-audit.js calls
// deadDispatchGuard directly to simulate backlog-wide refusal state and must
// stay untouched (plan review, second-opinion, 2026-08-26).
function checkDeadDispatch(task, workspaces, ledgerEntries, isDoneTitleFn, claudeAliveInFn, surfaceAliveFn, opts, sessionAliveFn = sessionAliveForTask) {
  const idle = workspaces.filter(w => !isDoneTitleFn(w.title) && cmuxws.checkLiveness(w.ref, claudeAliveInFn, surfaceAliveFn).dead);
  const allFreshDead = dispatchLedger.deadBreadcrumbs(idle, ledgerEntries);
  const sessionAlive = sessionAliveFn(task.id);
  const notThisTaskDead = (e) => !(dispatchLedger.isDeadlikeEvent(e.event) && String(e.taskId) === String(task.id));
  const freshDead = sessionAlive ? allFreshDead.filter(notThisTaskDead) : allFreshDead;
  const priorEntries = sessionAlive ? ledgerEntries.filter(notThisTaskDead) : ledgerEntries;
  const refusal = deadDispatchGuard(task, priorEntries.concat(freshDead), opts);
  return { freshDead, refusal };
}

// BRO-268: the session-shaped liveness signal checkDeadDispatch needs to see
// past a dead-looking cmux workspace. bsc-runner.js's per-task lease file
// (data/audit/job-leases/<taskId>/lease.json) is written at spawn and kept
// current with the live pid (runJob's onSpawn/onSessionId callbacks) by
// every headless dispatch path — independent of which workspace/pty, if
// any, is currently associated with the task. pidLooksLikeClaude
// re-validates the recorded pid's argv (guards a recycled pid — the same
// check acquireLease() already relies on to detect a stale lease and steal
// it).
//
// Deliberately fails the OPPOSITE direction from worktree-live-lease-check.js's
// hasLiveLease (which reads a null/pending pid as "alive" — fail-safe toward
// NOT reclaiming a worktree mid-acquisition): here a missing/unconfirmed pid
// must read as "not alive," because the failure cost is inverted — this
// signal only ever SUPPRESSES a dead-dispatch refusal, so erring toward
// "alive" would let a truly-dead task dodge the guard it exists to enforce.
//
// pidLooksLikeClaude ALONE is not enough here (adversarial review, two
// independent passes converged on the same finding — Codex + a Claude
// codebase review, 2026-08-26): it only re-checks that the pid's CURRENT
// argv looks like `claude`, never that it's the SAME process the lease was
// written for. A lease left behind by a hard crash (no releaseLease() ever
// ran) is stale; if the OS later recycles that exact pid number onto an
// unrelated claude process (e.g. the owner opening a manual session),
// isAliveFn alone would say "alive" and this function would silently erase
// every historical 'dead' breadcrumb for the task, un-refusing a redispatch
// with zero downstream net to catch it — bsc-next.js's cmux-tab dispatch
// path has no independent lease check the way the headless path's own
// acquireLease() does. pidStartedNear cross-checks the pid's actual process
// start time against the lease's acquiredAt: a legitimate holder's process
// starts within seconds of its own lease write (acquireLease() writes the
// lease immediately before spawn); a later, recycled pid necessarily starts
// well after. Fails safe toward "not confirmed" (false) on any ps error or
// unparseable timestamp — same fail-direction as the rest of this function.
const PID_START_GRACE_MS = 10 * 60 * 1000; // spawn + boot time, generous

// `ps -o etime=` (elapsed time, `[[dd-]hh:]mm:ss`) rather than `lstart=`
// (absolute local-time-with-no-offset, e.g. "Wed Aug 26 15:00:03 2026") —
// lstart is unparseable against an ISO/UTC lease timestamp without knowing
// the machine's local offset, which bit the first cut of this function
// (macOS EDT vs. lease.acquiredAt's UTC read 4 hours "late" and false-failed
// every real case). etime is a pure duration, immune to timezone entirely.
function parseElapsedMs(etime) {
  const s = String(etime).trim();
  const dashIdx = s.indexOf('-');
  const days = dashIdx === -1 ? 0 : parseInt(s.slice(0, dashIdx), 10);
  const rest = dashIdx === -1 ? s : s.slice(dashIdx + 1);
  const parts = rest.split(':').map((n) => parseInt(n, 10));
  if (Number.isNaN(days) || parts.some(Number.isNaN) || (parts.length !== 2 && parts.length !== 3)) return null;
  const [h, m, sec] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return (((days * 24 + h) * 60 + m) * 60 + sec) * 1000;
}

function pidStartedNear(pid, sinceIso, { execFn = execFileSync, nowMs = Date.now() } = {}) {
  if (!pid || !sinceIso) return false;
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return false;
  let out;
  try {
    out = execFn('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
  } catch { return false; }
  const elapsedMs = parseElapsedMs(out);
  if (elapsedMs == null) return false;
  const started = nowMs - elapsedMs;
  // A tiny negative slop (clock skew / lease written a beat after spawn on
  // some paths) is tolerated; only "started well AFTER the lease" is treated
  // as a mismatch — that's the recycled-pid shape this guards against.
  return started - since < PID_START_GRACE_MS;
}

function sessionAliveForTask(taskId, { readLeaseFn = readLease, isAliveFn = pidLooksLikeClaude, pidStartedNearFn = pidStartedNear } = {}) {
  const lease = readLeaseFn(taskId);
  if (!lease || !lease.pid || !isAliveFn(lease.pid)) return false;
  // No acquiredAt on the lease (shouldn't happen — acquireLease() always
  // stamps one) means we can't cross-check identity; fail toward not-alive
  // rather than trusting a bare pid match.
  if (!lease.acquiredAt) return false;
  return pidStartedNearFn(lease.pid, lease.acquiredAt);
}

// Notion-mirror convenience: extract an embedded `[notion:<uuid>]` tag from a
// task's free-text description, or null when absent (every non-Notion
// caller, e.g. linear-next.js's pseudoTask, which never carries this tag).
function notionIdOf(task) {
  const m = /\[notion:([a-f0-9-]+)\]/i.exec((task && task.description) || '');
  return m ? m[1] : null;
}

// Reads the import mapping linear-import.js maintains (data/linear-import-
// mapping.json, keyed by mirror task id — see that file's saveMapping()).
// Missing/corrupt file degrades to {} (fail OPEN — a task never gets falsely
// blocked because the mapping couldn't be read), matching every other
// missing-data case in this file.
function loadLinearMirrorMapping(mappingPath = LINEAR_MAPPING_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

// Single-dispatch-side guard (Phase 0 rail 1, plan 2026-08-12, task #1341):
// a task linear-import.js has already mapped to a LIVE Linear issue must be
// worked from Linear, not re-dispatched from the Notion-mirror side — the two
// dispatchers (bsc-next.js / linear-next.js) share no lock, so a live overlap
// window is a real double-dispatch, not a theoretical one.
//
// WHY THIS READS data/linear-import-mapping.json AND NOT A FIELD ON THE
// MIRROR TASK ITSELF: notion-tasks-sync.js's cmdPull update path (see its
// `for (const { card, taskId } of plan.toUpdate)` loop) rebuilds each mirror
// task from the live Notion card on every pull and carries over ONLY
// `existing.blocks`/`existing.blockedBy` from the file being replaced —
//   const task = { ...mapped, blocks: existing.blocks || [], blockedBy: existing.blockedBy || [] };
// Any other field written directly onto a mirror task JSON (e.g. a `linear:
// {...}` marker) would be silently dropped the next time notion-tasks-sync.js
// pull runs, which happens on essentially every dispatch loop iteration. The
// import mapping file is untouched by that sync — the more robust join.
//
// A mapping entry counts as a LIVE Linear counterpart only when it carries an
// identifier AND was not retired to Archive at import time (`retiredReason`
// set, or `project === 'Archive'`, cover the same case — see
// linear-import.js's classifyTask/runReconcile: a task already Done/noise/
// idle-stale in Notion gets parked in Linear's Archive project instead of a
// live workstream one, and is not "live work on the other side" for this
// guard's purposes).
//
// Known gap: the mapping is keyed by the mirror's OWN numeric task id, which
// notion-tasks-sync.js keeps stable per Notion card (readMap/writeMap, keyed
// on card.id) except in the rare case a task file was clobbered/reused by a
// live session (cmdPull's doCreate fallback reallocates a fresh id then).
// If that happens, this guard fails OPEN (dispatches) rather than blocking on
// a mapping key that no longer matches — same fail-open direction as every
// other guard in this file's missing-data case.
// Cross-session worktree/job-branch collision guard (card #1281): a LOCAL
// git branch already carrying commits not yet on origin/main for this task
// means another session already worked it — or is still working it — outside
// findLiveWorkspaceForTask's cmux-only view (a dead/closed cmux tab, a
// headless bsc-runner.js job, or a worktree nobody has pushed yet). Confirmed
// real: task #1233's fix was independently dispatched 3+ times — 3 dead cmux
// attempts, then 2-3 concurrent successful sessions, each doing a full
// independent implementation before any merged — with at least 3 distinct
// local branches for the identical fix, none of which findLiveWorkspaceForTask
// ever looks at (it only scans currently-live cmux workspace TITLES).
//
// Two branch-naming conventions carry per-task provenance: EnterWorktree
// names a branch worktree-<name>, usually with the task id first
// (worktree-1233-infra-death-cap); bsc-runner.js's headless jobs use
// job/<taskId>-<jobSuffix> instead (see gitSafeJobId in lib/bsc-runner.js).
// Both prefixes are checked so a collision can't slip through just because
// the second dispatch happened to be headless instead of cmux, or vice versa.
//
// Known gap: a branch that never mentions the task id at all in its name
// (e.g. task #1233's own third branch, worktree-dead-dispatch-cap-infra-
// split — a freeform rename) is structurally invisible to an id-anchored
// match. Nothing records task-id provenance for a worktree/job branch beyond
// its own name, so this cannot be closed without a separate provenance
// signal (e.g. stamping the task id into the ledger at EnterWorktree time).
const WORK_BRANCH_PREFIXES = ['worktree-', 'job/'];

// BRO-278: a Linear-issue taskId (`linear:BRO-278`, linear-next.js's
// ledgerTaskId()) is NOT what ends up in the branch name — git rejects the
// colon, so bsc-runner.js's gitSafeJobId() sanitizes it to `linear-BRO-278`
// before `job/${safe}` is ever created (verified live: this session's own
// branch is `job/linear-BRO-278-mtaf33qe`). Matching the RAW taskId against
// branch names therefore could never match a single Linear dispatch — the
// colon/dash mismatch made workBranchCollisionGuard structurally blind to
// every Linear-issue collision, exactly the cross-session collision BRO-278
// reports (three cmux workspaces on the identical issue, undetected).
// Sanitizing here with the SAME function closes that gap; for bsc-next.js's
// plain numeric ids gitSafeJobId is a no-op (digits are already git-ref
// safe), so this is a pure generalization, not a behavior change for the
// existing caller.
function matchesTaskWorkBranch(branchName, taskId) {
  const id = String(taskId == null ? '' : taskId).trim();
  if (!id) return false;
  const name = String(branchName || '');
  const safeId = gitSafeJobId(id);
  const escaped = safeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Anchored on both ends (a trailing "-" after a prefix match, or a leading
  // "-" before a suffix match) so task #123 can never match a branch for
  // task #1233 (or vice versa) on a bare numeric-substring coincidence.
  const re = new RegExp(`^(?:${escaped}-|.*-${escaped}$)`);
  return WORK_BRANCH_PREFIXES.some(prefix => name.startsWith(prefix) && re.test(name.slice(prefix.length)));
}

// Pure: given a pre-computed list of {name, unlandedCommits: string[]} (see
// scripts/lib/worktree-branch-guard.js's listWorkBranchStatuses for how that
// list is built — is-ancestor + git cherry, squash-merge aware), find the
// ones that belong to this task AND still carry commits origin/main has
// never seen. An empty unlandedCommits means that branch's work already
// reached origin (merged/pushed, including via squash) — not a collision.
function findWorkBranchCollisions(taskId, branchStatuses) {
  return (branchStatuses || [])
    .filter(b => b && matchesTaskWorkBranch(b.name, taskId))
    .filter(b => Array.isArray(b.unlandedCommits) && b.unlandedCommits.length > 0);
}

// Same shape/bypass convention as this file's other guards: (task, data,
// opts), pure, returns a refusal string or null; opts.force/dry-run/print-
// prompt bypass it — the same "yes I know, second workspace anyway" escape
// hatch every sibling guard already uses.
function workBranchCollisionGuard(task, branchStatuses, opts) {
  if (opts.force || opts['dry-run'] || opts['print-prompt']) return null;
  const collisions = findWorkBranchCollisions(task.id, branchStatuses);
  if (!collisions.length) return null;
  const lines = collisions.map(c => {
    const first = c.unlandedCommits[0];
    const more = c.unlandedCommits.length > 1 ? `, +${c.unlandedCommits.length - 1} more` : '';
    return `    ${c.name}: ${c.unlandedCommits.length} commit(s) not yet on origin/main — ${first}${more}`;
  });
  return `REFUSING to dispatch #${task.id}: local branch(es) already carry unlanded work for this task:\n` +
    `${lines.join('\n')}\n` +
    `  Another session likely already worked (or is still working) this card there — dispatching again risks a\n` +
    `  duplicate independent implementation (card #1281: card #1233 was independently redone 2-3x this way). Inspect first:\n` +
    `    git log origin/main..${collisions[0].name} --oneline\n` +
    `  If that work is stale/abandoned, merge or discard it, then dispatch. Re-run with --force to dispatch anyway.`;
}

// Exact-title duplicate-dispatch refusal (task #1672). dispatch-overlap-check.js's
// findOverlappingCards has been warn-only on EVERY title overlap since task
// #917 — deliberately, because a prefix match or a shared scripts/ path is
// suggestive, not proof (two cards can legitimately touch the same file for
// unrelated reasons). A byte-for-byte normalized subject match against a LIVE
// in_progress card is a different case: it is proof, not a hint. Confirmed
// real 2026-08-16: task #1662 and #1670 had an exact subject match,
// bsc-next.js printed the WARNING and dispatched anyway, and two parallel
// worktrees independently built the identical helper file — wasted spend for
// a signal the dispatcher had already computed and discarded. Second-opinion
// review, 2026-08-16: spot-checked the live task mirror (197 in_progress
// cards) and found 7 exact-title-duplicate groups, all genuine duplicates
// (different Notion cards describing the same bug) — no false positive.
// Fuzzy prefix overlap and shared-file-path stay warn-only (unchanged) — only
// 'exact-title-match' refuses. Takes a pre-computed `overlaps` array (the
// caller's own findOverlappingCards() result) rather than recomputing it, so
// bsc-next.js's refusal check and its warn-loop over the remaining overlaps
// can't drift out of lock-step by calling the underlying match twice.
//
// CONTRACT: `overlaps` must already be findOverlappingCards(task, others)'s
// OUTPUT (an array of {card, reason, sharedPaths}), not the raw in_progress
// card list — passing a raw card list silently finds no 'exact-title-match'
// entries and returns null, which reads as "guard does not work" rather than
// "caller passed the wrong shape" (flagged in manual verification, 2026-08-16).
function exactTitleOverlapGuard(task, overlaps, opts) {
  if (opts.force || opts['dry-run'] || opts['print-prompt']) return null;
  const exact = (overlaps || []).find(o => o.reason === 'exact-title-match');
  if (!exact) return null;
  return `REFUSING to dispatch #${task.id}: its title is an exact match with in_progress task ` +
    `#${exact.card.id} ("${exact.card.subject}") — a byte-for-byte subject match against live in_progress ` +
    `work isn't suggestive, it's proof the same work is already being dispatched. Confirm #${exact.card.id} ` +
    `isn't already covering this before dispatching a duplicate. Re-run with --force to dispatch anyway.`;
}

// Mirror-staleness dispatch claim (task #1896): exactTitleOverlapGuard above
// only sees a duplicate once the OTHER task's local mirror already says
// in_progress — and nothing flips a task's mirror status to in_progress
// until the dispatched session itself gets around to calling notion-brain.js,
// which can be MINUTES after cmux/headless already launched (confirmed live
// 2026-08-26: task #1893 was independently launched 4x in ~8 minutes,
// including two successful dispatches — a cmux tab and a headless job — only
// 30 seconds apart). This guard closes that gap for THIS SAME task id: the
// caller acquires an atomic per-task claim (scripts/lib/atomic-claim.js)
// BEFORE running the rest of the fresh-dispatch guard chain, and this
// function turns the claim's result into a refusal. Pure, like every other
// guard here — the mkdir/EEXIST I/O happens at the call site (bsc-next.js),
// this only interprets its outcome. `claimResult` is exactly acquireClaim()'s
// return value: true (claimed — proceed), false (genuinely held elsewhere,
// not stale), or 'error' (existing claim unreadable/corrupt — fail closed).
//
// Deliberately NOT added to GUARD_NAMES below: every guard listed there is a
// pure evaluation the queue-audit CLI wrapper can safely "what would this
// say" simulate against every queued task without side effects. This guard's
// precondition is a real mkdir claim (acquireClaim) — simulating it across
// the whole backlog would mutate claim state for tasks nobody is actually
// dispatching, which is exactly the bug this guard exists to prevent.
function dispatchClaimGuard(task, claimResult, opts) {
  if (opts.force || opts['dry-run'] || opts['print-prompt']) return null;
  if (claimResult === true) return null;
  if (claimResult === 'error') {
    return `REFUSING to dispatch #${task.id}: could not acquire the per-task dispatch claim (claim dir ` +
      `unreadable/corrupt) — failing closed rather than risk a concurrent double-dispatch.`;
  }
  return `REFUSING to dispatch #${task.id}: another dispatch attempt for this exact task claimed it very ` +
    `recently and hasn't released it yet — this is the mirror-staleness race (task #1896): the local task ` +
    `mirror won't show this task as in_progress until the OTHER dispatch's session gets around to marking it, ` +
    `which can be minutes away. Wait for that attempt to resolve (a workspace/job should appear shortly), ` +
    `verify it actually died first, or re-run with --force to dispatch anyway.`;
}

// Session-tracking clone refusal (task #1672, defect 2): worker sessions
// routinely create a SECOND Notion card to track their own in-flight
// implementation of a pre-existing card ("Session tracking card for task
// #1557", "Working parent card <uuid> (P1 #1660)", etc). actionable()
// includes in_progress tasks, and --id reaches any task directly, so these
// self-declared clones are exactly as dispatchable as real backlog — that's
// how task #1670 (a clone) became a duplicate workspace alongside #1662's own
// duplicate. staleOutcomeGuard doesn't catch this: it only engages on
// status === 'completed', and these clones are in_progress. Deliberately keys
// off the SELF-DECLARED phrase in notes/description rather than a "Session:"
// title prefix — #1353 and #1659 are the identical pathology with plain
// titles, so a prefix match would miss them.
//
// Requires BOTH the clone-phrase AND an extractable parent reference before
// refusing (second-opinion review, 2026-08-16): the phrase alone (especially
// the generic "parent card" alternative) could plausibly appear in a card
// that's legitimately ABOUT this mechanism, not a clone of one. A phrase with
// no extractable parent id fails open (returns null) rather than refusing on
// a half-signal — same fail-open direction every other guard in this file
// takes on ambiguous/missing data.
//
// Task #1698 (P1 regression): phrase+parent-ref alone was still wrong in both
// directions. False positives — #1615's "parent card <uuid>, shipped
// 2026-04-24" and #1674's "per card #1657" (already merged) — are CITATIONS
// of finished work, not clone declarations; the guard never checked whether
// the referenced parent was actually live. False negatives — #1670's "per
// card <uuid> (task #1662)" never matched the old `per\s+(?:task|card)\s*#\d+`
// branch (no `#digit` immediately after "card"), and #1680's self-declaration
// sat in the TITLE ("...continuing card #N)") while the only matching phrase
// ("session-tracking card") was later in the description, so the forward-only
// window search in extractCloneParentRef() never looked far enough back.
// Fixed by widening the "per" branch (extractCloneParentRef's own window
// search already finds the id either way) and adding "continuing card" so a
// title-only self-declaration is the leftmost match; the false-positive half
// is fixed by sessionTrackingCloneGuard() itself now requiring the resolved
// parent to be LIVE (see below) rather than trusting phrase+ref alone.
//
// Known gap (ship-check Codex finding, 2026-08-16, NOT closed by the live-
// parent gate): "per card #N" / "per task #N" is still a bare citation form,
// not a self-declaration — a genuinely distinct backlog card that says
// "implements the follow-up work per card #1660" while #1660 happens to be
// in_progress (someone else's unrelated live work) will still be refused,
// even though it isn't a clone of #1660. The live-parent gate only closes
// the false-positive window for citations of FINISHED work (this task's own
// #1615/#1674); a citation of unrelated but currently-active work remains a
// real, undetected false-positive class. Not solvable with a regex — telling
// "this card IS a clone of X" from "this card CITES X, which happens to be
// live" needs semantic understanding this heuristic doesn't have. Accepted
// per this task's own stated tradeoff (a false positive costs real backlog;
// `--force` is the escape hatch) rather than dropping the "per card/task"
// branch entirely, which would silently un-fix #1670's motivating case.
const SESSION_TRACKING_CLONE_RE = /\b(?:session[\s-]*tracking\s+card|working\s+parent\s+card|parent\s+card|per\s+(?:task|card)|continuing\s+card)\b/i;

// How far past the matched clone-phrase to look for the parent reference.
// Bounded so a stray unrelated #N or UUID elsewhere in a long description
// can't be misread as the parent — real observed distances (e.g. "Working
// parent card <uuid> (P1 #1660)") are well under this.
const CLONE_PARENT_REF_WINDOW = 200;

// `fromIndex` anchors the search to right after the clone-phrase match
// (found live, task #1661: without an anchor, a naive whole-text scan for
// the first UUID-shaped string grabbed this task's OWN `[notion:<uuid>]`
// self-tag — which always sits earlier in the text — instead of the actual
// parent referenced later in the notes). Bare `#(\d+)` (no "task"/"card"
// prefix requirement) inside the window also catches "(P1 #1660)"-style
// parenthetical refs that a stricter prefix-anchored pattern would miss.
function extractCloneParentRef(text, fromIndex) {
  const window = text.slice(fromIndex, fromIndex + CLONE_PARENT_REF_WINDOW);
  const numeric = /#(\d+)/.exec(window);
  if (numeric) return { kind: 'task', id: numeric[1] };
  const uuid = /\b([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})\b/i.exec(window);
  if (uuid) return { kind: 'notion', id: uuid[1] };
  return null;
}

// Deliberately does NOT also match a bare 8-hex-char short id (e.g. some
// cards abbreviate a Notion uuid to just its first segment, "3be637c5", in
// prose). Verified live against the real mirror (task #1698 sweep,
// 2026-08-16): 42 unrelated cards share that exact 8-char prefix (22 of them
// in_progress/pending) — it's a workspace/database-level prefix, not a
// unique-enough fragment to resolve safely. Matching it would trade one
// known false negative (a card whose parent ref is this ambiguous — fails
// open, same as any other unresolvable reference) for near-certain false
// positives against whichever unrelated live card happens to share the
// prefix and sorts first in the mirror.

// 'in_progress' ONLY — NOT 'pending' (ship-check Codex finding, task #1698).
// notion-tasks-sync.js's mapStatus() collapses Notion's "Not started" AND
// "Paused" into 'pending' (its default case) alongside genuine queued
// backlog, so 'pending' does not mean "someone has this open right now" —
// it can equally mean "nobody has started it" or "explicitly paused". The
// refusal message says "opens a duplicate session alongside whatever is
// ALREADY TRACKING" the parent, which is only true when a session is
// actually running against it — that's 'in_progress' alone.
const LIVE_TASK_STATUSES = new Set(['in_progress']);

// UUIDs from card TEXT may or may not carry hyphens (extractCloneParentRef's
// UUID regex makes them optional), but notionIdOf() always returns the
// hyphenated `[notion:<uuid>]` form as-tagged — compare both sides
// hyphen-stripped so a hyphen-stripped id in a card's prose still matches its
// referenced task (second-opinion review, 2026-08-16).
function normalizeNotionId(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

// Resolves a clone-parent reference (see extractCloneParentRef) to the
// task it actually points at, using the SAME task-mirror array the caller
// already has in hand (bsc-next.js's `tasks`, loaded once in main()) — no
// I/O of its own, same shape as this file's other data-taking guards
// (deadDispatchGuard(task, ledgerEntries, opts), workBranchCollisionGuard
// (task, branchStatuses, opts): extra data is a plain array, not a
// pre-built lookup — no guard in this file pre-builds a Map).
//
// Returns null (fails open, same direction as every other guard here on
// ambiguous/missing data) when: no tasks array was passed, the referenced id
// isn't found in it, OR the reference resolves to the task itself — a card
// can plausibly restate its own numeric id near the clone phrase (e.g.
// templated boilerplate), and since the task being evaluated is by
// definition live (it's mid-dispatch), a naive self-match would always read
// as "live parent" and refuse a card for citing itself.
function resolveCloneParentTask(task, parent, tasks) {
  if (!parent || !Array.isArray(tasks)) return null;
  if (parent.kind === 'task') {
    if (String(parent.id) === String(task && task.id)) return null;
    return tasks.find(t => t && String(t.id) === String(parent.id)) || null;
  }
  const needle = normalizeNotionId(parent.id);
  const found = tasks.find(t => t && normalizeNotionId(notionIdOf(t)) === needle) || null;
  if (found && String(found.id) === String(task && task.id)) return null;
  return found;
}

// (task, tasks, opts) — extra data before opts, matching every sibling guard
// in this file (deadDispatchGuard, parkedGuard, workBranchCollisionGuard,
// exactTitleOverlapGuard, linearMirrorGuard all take (task, data, opts)).
function sessionTrackingCloneGuard(task, tasks, opts) {
  // Defensive default (ship-check Codex finding, task #1698): this guard's
  // signature changed from (task, opts) to (task, tasks, opts) — a stray
  // 2-arg caller would otherwise crash on `opts.force` instead of failing
  // open like every other guard in this file on missing data. No such
  // caller exists today (verified: bsc-next.js:810 is the only call site),
  // but the cost of this guard is one line.
  opts = opts || {};
  if (opts.force || opts['dry-run'] || opts['print-prompt']) return null;
  const raw = `${(task && task.subject) || ''}\n${(task && task.description) || ''}`;
  // Strip this task's own `[notion:<uuid>]` self-tag (notionIdOf's format)
  // FIRST — otherwise it's indistinguishable from a genuine parent reference
  // to extractCloneParentRef's UUID fallback.
  const text = raw.replace(/\[notion:[a-f0-9-]+\]/gi, '');
  const phraseMatch = SESSION_TRACKING_CLONE_RE.exec(text);
  if (!phraseMatch) return null;
  const parent = extractCloneParentRef(text, phraseMatch.index);
  if (!parent) return null;
  // Task #1698: a phrase + extractable ref is still only a CITATION unless
  // the referenced parent is confirmed live right now — resolve it in the
  // task mirror and fail open (no refusal) when it can't be confirmed live.
  // A false negative here costs at most one duplicate workspace (usually
  // caught by exactTitleOverlapGuard's byte-for-byte title match anyway); a
  // false positive silently drops real backlog work with nobody noticing —
  // same asymmetry every other guard in this file already resolves in favor
  // of failing open.
  //
  // `tasks` is a stale, non-atomic snapshot (ship-check Codex finding,
  // 2026-08-16) — the caller loads it once at the top of main(), and
  // notion-tasks-sync.js can replace individual task files underneath this
  // process between that read and the eventual cmux/headless launch. A
  // parent could complete (this guard's false negative — dispatches anyway,
  // same bounded cost as above) or start (false positive — refuses on now-
  // stale "not live" data) in that window. Every other liveness check in
  // this file (deadDispatchGuard's ledger read, parkedGuard's ledger read)
  // has the identical structural gap; closing it needs a reservation/lock
  // this dispatch-guard architecture doesn't have, not a fix scoped to this
  // one guard.
  const parentTask = resolveCloneParentTask(task, parent, tasks);
  if (!parentTask || !LIVE_TASK_STATUSES.has(parentTask.status)) return null;
  const parentRef = parent.kind === 'task' ? `task #${parent.id}` : `Notion card ${parent.id}`;
  const dispatchHint = parent.kind === 'task' ? ` (node scripts/bsc-next.js --id ${parent.id})` : '';
  return `REFUSING to dispatch #${task.id}: its own notes self-identify it as a session-tracking clone of ` +
    `${parentRef}, not standalone backlog work — dispatching it opens a duplicate session alongside whatever ` +
    `is already tracking ${parentRef}. If that original work stalled, dispatch ${parentRef}${dispatchHint} ` +
    `directly instead. Re-run with --force to dispatch anyway.`;
}

/**
 * The single definition of "this task is owned by the Linear side right now".
 *
 * Extracted so the CANDIDATE QUERY and the DISPATCH GUARD cannot disagree.
 * Before this, linearMirrorGuard ran only at dispatch time, so bsc-next.js's
 * actionable() kept offering tasks that dispatch would always refuse: measured
 * 2026-08-17, 122 of 400 actionable candidates (30%) were in that state — they
 * resurfaced every cycle and could never be actioned. Filtering them out of the
 * candidate list with a second, hand-rolled "is it live" test would have been the
 * classic drift bug (memory/feedback_includability_predicates_must_be_canonical),
 * so both callers ask this one function.
 *
 * Returns the mapping entry when the task is live on the Linear side, else null,
 * so callers can name the identifier without re-reading the mapping.
 *
 * Fails OPEN (returns null) on missing/!corrupt mapping data, matching every
 * other guard in this file: loadLinearMirrorMapping() yields {} on any read or
 * parse error, so a lost mapping makes tasks dispatchable again rather than
 * silently deleting 122 tasks from the queue.
 */
function liveLinearCounterpart(task, mapping) {
  const entry = mapping && task ? mapping[String(task.id)] : null;
  if (!entry || !entry.identifier) return null;
  if (entry.retiredReason || entry.project === 'Archive') return null; // parked, not live work
  return entry;
}

function linearMirrorGuard(task, mapping, opts) {
  if (opts.force || opts['dry-run'] || opts['print-prompt']) return null;
  const entry = liveLinearCounterpart(task, mapping);
  if (!entry) return null;
  return `task #${task.id} already has a live Linear counterpart (${entry.identifier}) — dispatching it from Notion risks two sessions working the same card. Use the Linear-side dispatcher instead:\n` +
    `  node scripts/linear-next.js --id ${entry.identifier}`;
}

// The 8 guard names, in call order, as a single source of truth for anything
// that needs to enumerate "every dispatch guard" without re-deriving the list
// (task #1802: scripts/lib/dispatch-guard-queue-audit.js tallies a refusal
// per name below across every queued task). Keeping this here, next to the
// functions it names, means adding a 9th guard can't silently leave the
// audit's list stale the way a second, standalone copy would.
const GUARD_NAMES = [
  'deadDispatchGuard',
  'parkedGuard',
  'staleOutcomeGuard',
  'closedCardGuard',
  'workBranchCollisionGuard',
  'exactTitleOverlapGuard',
  'sessionTrackingCloneGuard',
  'linearMirrorGuard',
];

module.exports = {
  GUARD_NAMES,
  findLiveWorkspaceForTask,
  deadDispatchGuard,
  parkedGuard,
  staleOutcomeGuard,
  isNativeTaskDoneWithoutCard,
  closedCardGuard,
  CLOSED_CARD_STATUSES,
  checkDeadDispatch,
  sessionAliveForTask,
  pidStartedNear,
  notionIdOf,
  loadLinearMirrorMapping,
  liveLinearCounterpart,
  linearMirrorGuard,
  exactTitleOverlapGuard,
  dispatchClaimGuard,
  sessionTrackingCloneGuard,
  resolveCloneParentTask,
  extractCloneParentRef,
  LINEAR_MAPPING_PATH,
  matchesTaskWorkBranch,
  findWorkBranchCollisions,
  workBranchCollisionGuard,
  WORK_BRANCH_PREFIXES,
  // Re-exported so both dispatchers have a single require() for all six
  // guards, per this file's header. Owning modules (verify-gate.js /
  // headless-dispatchability.js) are unchanged — this is a re-export, not a
  // second copy.
  evaluateVerifiability,
  classifyHeadlessDispatchability,
  HEADLESS_BLOCKERS,
};
