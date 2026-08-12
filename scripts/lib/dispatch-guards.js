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
const dispatchLedger = require('./dispatch-ledger.js');
const cmuxws = require('./cmux-workspaces.js');
const { evaluateVerifiability } = require('./verify-gate.js');
const { classifyHeadlessDispatchability, BLOCKERS: HEADLESS_BLOCKERS } = require('./headless-dispatchability.js');
const { parseRecheckAfterFromCard } = require('./recheck-stamp.js');

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
function staleOutcomeGuard(task, card, opts) {
  if (opts.force || opts['allow-unverifiable'] || opts['dry-run'] || opts['print-prompt']) return null;
  const outcome = card && String(card.outcome || '').trim();
  if (!outcome) return null;
  if (evaluateVerifiability((card && card.notes) || '').armed) return null;
  if (parseRecheckAfterFromCard(card)) return null;
  const pid = notionIdOf(task);
  return `REFUSING to dispatch #${task.id}: its card already has a filled Outcome (recorded ` +
    `completed work) and no acceptance criteria to verify a new attempt against. This looks like the #383 class ` +
    `(done-but-never-closed), not a fresh dispatch.\n` +
    `  Fix one of:\n` +
    `    1. Close the card as Done if the recorded Outcome is sufficient${pid ? ` (Notion): node scripts/notion-brain.js update ${pid} --status Done` : ''}.\n` +
    `    2. Add a backticked safe-form command to the card's "## Acceptance criteria" stating what's still missing.\n` +
    `    3. Re-run with --force (or --allow-unverifiable) to dispatch anyway (recorded in the ledger).`;
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
function checkDeadDispatch(task, workspaces, ledgerEntries, isDoneTitleFn, claudeAliveInFn, surfaceAliveFn, opts) {
  const idle = workspaces.filter(w => !isDoneTitleFn(w.title) && cmuxws.checkLiveness(w.ref, claudeAliveInFn, surfaceAliveFn).dead);
  const freshDead = dispatchLedger.deadBreadcrumbs(idle, ledgerEntries);
  const refusal = deadDispatchGuard(task, ledgerEntries.concat(freshDead), opts);
  return { freshDead, refusal };
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
function linearMirrorGuard(task, mapping, opts) {
  if (opts.force || opts['dry-run'] || opts['print-prompt']) return null;
  const entry = mapping && mapping[String(task.id)];
  if (!entry || !entry.identifier) return null;
  if (entry.retiredReason || entry.project === 'Archive') return null; // parked, not live work
  return `task #${task.id} already has a live Linear counterpart (${entry.identifier}) — dispatching it from Notion risks two sessions working the same card. Use the Linear-side dispatcher instead:\n` +
    `  node scripts/linear-next.js --id ${entry.identifier}`;
}

module.exports = {
  findLiveWorkspaceForTask,
  deadDispatchGuard,
  parkedGuard,
  staleOutcomeGuard,
  checkDeadDispatch,
  notionIdOf,
  loadLinearMirrorMapping,
  linearMirrorGuard,
  LINEAR_MAPPING_PATH,
  // Re-exported so both dispatchers have a single require() for all six
  // guards, per this file's header. Owning modules (verify-gate.js /
  // headless-dispatchability.js) are unchanged — this is a re-export, not a
  // second copy.
  evaluateVerifiability,
  classifyHeadlessDispatchability,
  HEADLESS_BLOCKERS,
};
