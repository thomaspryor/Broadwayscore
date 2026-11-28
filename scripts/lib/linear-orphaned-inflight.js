'use strict';

/**
 * linear-orphaned-inflight.js — re-own Linear work whose session died (BRO-2989).
 *
 * THE GAP. A card in a 'started' state whose owning session dies WITHOUT
 * finishing had no recovery path for ~48h, and none at all for owner cards:
 *   - linear-watchdog-source.js ineligibleReason refuses every 'started' card
 *     ('already-started'), and the watchdog's dead-retry runs linear-next
 *     without --force, which startedStateGuard refuses.
 *   - the BRO-3925/4510 zombie sweep only handles a job that finished
 *     cleanly (job-done) without reporting.
 *   - linear-reclaim-abandoned waits RECLAIM_IDLE_MS (48h) and skips 👑/OWNER
 *     cards outright.
 * So a crown generation that died stayed "In Progress" and read to the owner
 * as a hang, while the loop re-crowned beside it.
 *
 * WHAT THIS DECIDES. For each started card, from LEDGER ROWS ONLY:
 *   - owner alive (any open job, caller-supplied live task)        -> untouched
 *   - latest attempt not dead                                       -> untouched
 *   - latest attempt dead by a SETTLED event (job-orphaned, which
 *     bsc-reconcile writes only after its two-tick debounce, or
 *     job-failed, or an unverified launch)                          -> acted on
 * Deliberately NOT acted on (ledger vocabulary says a dead-shaped row is not
 * always a dead owner): job-abandoned (another job holds the card),
 * job-stranded/unlanded (real commits exist that a fresh session would orphan),
 * and a vanished/parked workspace (the owner or bsc-prune made that call).
 *
 * ACTIONS. 'redispatch': move to Todo so the watchdog picks it up, only when
 * the watchdog would actually accept it. 'notify-owner': owner/crown cards are
 * NEVER auto-redispatched or auto-answered, and cards the watchdog would
 * refuse or that exhausted dispatchCapDecision cannot be re-owned by the
 * machine — both must reach the owner. One action per dead attempt
 * (`handled` keys), so a card is never acted on twice for the same death.
 *
 * Pure: the caller (bsc-reconcile sweepOrphanedLinearInFlight) does every
 * fetch / Linear write / report.
 */

const ledger = require('./dispatch-ledger.js');
const { linearTaskId, ineligibleReason } = require('./linear-watchdog-source.js');
const { REOWN_MARKER } = require('./linear-started-zombie-sweep.js');
const { scanThreadSinceSpawn } = require('./linear-started-zombie-sweep-verify.js');
const { OWNER_CARD_RE, NO_RECLAIM_RE } = require('./linear-reclaim-abandoned.js');

const { JOB_EVENTS } = ledger;

// The dead event must have been settled by something other than one liveness
// glance. ORPHANED is written by sweepOrphanedJobs only after its suspect ->
// confirm debounce (BRO-3052).
const SETTLED_DEAD_EVENTS = new Set([JOB_EVENTS.ORPHANED, JOB_EVENTS.FAILED]);
const GRACE_MS = 30 * 60 * 1000;
const MAX_PER_TICK = 5;

const KINDS = Object.freeze({ REDISPATCH: 'redispatch', NOTIFY_OWNER: 'notify-owner' });

function handledKey(taskId, deadTs) { return `${taskId}|${deadTs}`; }

// An unverified launch is only a death when failedLaunchEntries wrote a paired
// 'dead' row for the same workspace (deadConfirmed). A bare unverified launch is
// the slow-boot case: the wrapper was STILL RUNNING and a real session is
// probably booting — cmux-tab sessions write no job rows, so nothing else would
// tell us it is alive.
function isSettledDead(entry, ledgerEntries = []) {
  if (!entry) return false;
  if (SETTLED_DEAD_EVENTS.has(entry.event)) return true;
  if (entry.event !== 'launch' || entry.unverified !== true) return false;
  return ledgerEntries.some((e) => e && e.event === 'dead' && String(e.taskId) === String(entry.taskId)
    && e.workspaceRef === entry.workspaceRef && Date.parse(e.ts) <= Date.parse(entry.ts));
}

/**
 * Cards worth a Linear fetch: latest attempt settled-dead and not yet handled,
 * NEWEST death first. Newest-first matters: the ledger holds hundreds of old
 * dead cards the classifier will skip every time (stopped-short, stranded...),
 * and an oldest-first slice would refetch the same ones forever and never reach
 * a card that died today.
 */
function selectOrphanCandidates(ledgerEntries, { handled = new Set(), limit = 25 } = {}) {
  const { findLinearDeadLaunchCandidates } = require('./linear-dead-completion-source.js');
  return findLinearDeadLaunchCandidates(ledgerEntries)
    .map((c) => ({ ...c, dead: ledger.resolveDeadAttempt(c.taskId, ledgerEntries) }))
    .filter((c) => c.dead && isSettledDead(c.dead, ledgerEntries) && !handled.has(handledKey(c.taskId, c.dead.ts)))
    .sort((a, b) => Date.parse(b.dead.ts) - Date.parse(a.dead.ts))
    .slice(0, limit);
}

/**
 * @param {object} o
 * @param {object[]} o.issues         live Linear issues (state, title, description, priority, comments)
 * @param {object[]} o.ledgerEntries  dispatch-ledger entries
 * @param {number}   o.nowMs
 * @param {Set<string>} [o.liveTaskIds]  taskIds the caller knows have a live owner (lease/process/workspace)
 * @param {Set<string>} [o.handled]      handledKey()s already acted on
 * @param {number}   [o.graceMs]
 * @param {number}   [o.maxPerTick]
 * @returns {{decisions: {kind:string, reason:string, identifier:string, taskId:string, issue:object, deadTs:string, deadEvent:string, key:string}[],
 *            skipped: {identifier:string, reason:string}[]}}
 */
function classifyOrphanedInFlight({
  issues, ledgerEntries, nowMs, liveTaskIds = new Set(), handled = new Set(),
  graceMs = GRACE_MS, maxPerTick = MAX_PER_TICK,
} = {}) {
  if (!Number.isFinite(nowMs)) throw new TypeError('classifyOrphanedInFlight: nowMs must be a finite number');
  if (!Array.isArray(ledgerEntries)) throw new TypeError('classifyOrphanedInFlight: ledgerEntries must be an array');
  const decisions = [];
  const skipped = [];
  const openTaskIds = new Set(ledger.openJobs(ledgerEntries).map((j) => String(j.taskId)));

  for (const issue of Array.isArray(issues) ? issues : []) {
    const identifier = issue && issue.identifier;
    if (!identifier) continue;
    const skip = (reason) => skipped.push({ identifier, reason });
    const state = issue.state || {};
    if (state.type !== 'started') { skip('not-started'); continue; }
    if (/review/i.test(state.name || '')) { skip('in-review'); continue; }
    if (NO_RECLAIM_RE.test(issue.description || '')) { skip('opted-out'); continue; }

    const taskId = linearTaskId(identifier);
    if (liveTaskIds.has(taskId) || openTaskIds.has(taskId)) { skip('owner-alive'); continue; }

    const dead = ledger.resolveDeadAttempt(taskId, ledgerEntries);
    if (!dead) { skip('latest-attempt-not-dead'); continue; }
    if (!isSettledDead(dead, ledgerEntries)) { skip(`dead-event-not-settled:${dead.event}`); continue; }
    // A timed-out job is still resumable by bsc-reconcile's resume path; moving
    // the card to Todo would let two sessions pick it up.
    if (dead.event === JOB_EVENTS.FAILED && dead.stage === 'timeout') { skip('timeout-resumable'); continue; }
    const deadMs = Date.parse(dead.ts);
    if (!Number.isFinite(deadMs)) { skip('dead-ts-unparseable'); continue; }
    // A vanished/parked workspace row at or after the death is the owner's (or
    // bsc-prune's) decision, not an orphan.
    const parked = ledgerEntries.some((e) => e && String(e.taskId) === taskId
      && (e.event === 'vanished' || e.event === 'prune-closed') && Date.parse(e.ts) >= deadMs);
    if (parked) { skip('owner-parked'); continue; }
    const key = handledKey(taskId, dead.ts);
    if (handled.has(key)) { skip('already-handled'); continue; }
    if (nowMs - deadMs < graceMs) { skip('within-grace'); continue; }

    const thread = scanThreadSinceSpawn(issue, dead.ts, nowMs);
    if (thread.truncated) { skip('comment-history-truncated'); continue; }
    if (thread.reported) { skip('already-reported'); continue; }
    if (thread.humanFresh) { skip('human-on-thread'); continue; }
    if (thread.ownReset) { skip('own-reset-unconfirmed'); continue; }

    const base = { identifier, taskId, issue, deadTs: dead.ts, deadEvent: dead.event, key };
    if (OWNER_CARD_RE.test(issue.title || '')) {
      decisions.push({ ...base, kind: KINDS.NOTIFY_OWNER, reason: 'owner-card-session-died' });
      continue;
    }
    const cap = ledger.dispatchCapDecision(taskId, ledgerEntries);
    if (cap.blocked) { decisions.push({ ...base, kind: KINDS.NOTIFY_OWNER, reason: `attempts-exhausted:${cap.reason}` }); continue; }
    const why = ineligibleReason({ ...issue, state: { type: 'unstarted', name: 'Todo' } });
    if (why) { decisions.push({ ...base, kind: KINDS.NOTIFY_OWNER, reason: `watchdog-would-refuse:${why}` }); continue; }
    decisions.push({ ...base, kind: KINDS.REDISPATCH, reason: 'owner-session-dead' });
  }

  // Cap moves, not notifications: a notification is one report line.
  let moves = 0;
  const capped = [];
  for (const d of decisions.sort((a, b) => Date.parse(a.deadTs) - Date.parse(b.deadTs))) {
    if (d.kind === KINDS.REDISPATCH && ++moves > maxPerTick) { skipped.push({ identifier: d.identifier, reason: 'tick-cap' }); continue; }
    capped.push(d);
  }
  return { decisions: capped, skipped };
}

function buildReownComment({ identifier, deadEvent, deadTs, kind, reason } = {}) {
  const head = `${REOWN_MARKER}: ${identifier}'s session died (${deadEvent} at ${deadTs}) without reporting back.`;
  return kind === KINDS.REDISPATCH
    ? `${head} Moved to Todo so the watchdog re-dispatches it.`
    : `${head} Not auto-redispatched (${reason}); the owner has been told.`;
}

module.exports = { classifyOrphanedInFlight, selectOrphanCandidates, isSettledDead, buildReownComment, handledKey, KINDS, REOWN_MARKER, GRACE_MS, MAX_PER_TICK };
