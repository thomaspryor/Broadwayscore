'use strict';

/**
 * land-mutex.js — pure decisions for BRO-5112's landing queue.
 *
 * land.yml's Land job used to sit in ONE global concurrency group, `landing`.
 * GitHub keeps one pending run per group and cancels the older pending run
 * when a newer one queues, so with ~8 landers (2026-10-11) every landing was
 * evicted 2-4 times and lived on land-retry-cancelled loops. The Land job's
 * group is now per branch, and the fast-forward is serialized by this FIFO
 * mutex built from git refs on origin (git ls-remote / push only, so polling
 * costs no REST quota):
 *
 *   refs/land-mutex/queue/<p>-<enqueuedMs>-<runId>-<attempt>
 *       one ticket per waiting run, pointing at its own parentless commit.
 *       <p> is 0 for a main-red fix lane (BRO-5096), 1 otherwise, so names
 *       sort into priority-then-FIFO order.
 *   refs/land-mutex/lock
 *       the holder's ticket sha. Created only with a create-only lease
 *       (`--force-with-lease=<ref>:`), so exactly one push can win it: mutual
 *       exclusion comes from this one compare-and-swap ref, and the queue only
 *       decides who tries. Two waiters that both think they are head cannot
 *       both hold the lock.
 *
 * Stale-break: a holder or queue head that has not moved for GRACE_MS is
 * checked against the Actions API. A run that completed, was deleted (HTTP 404),
 * or re-ran as a newer attempt is gone; the lock/ticket is deleted with a lease on the
 * exact sha seen, so a breaker can never delete a lock someone re-took in
 * between. Unreadable API → gone only past STALE_AGE_MS from enqueue (longer
 * than any job's timeout). A lock whose ticket is missing (its holder's ticket
 * was dropped as stale) is broken after it stays orphaned for GRACE_MS.
 *
 * The caller (scripts/land-mutex.js) fails OPEN at its deadline or when the
 * remote refuses the refs: land.js still makes ONE non-force fast-forward
 * push that git rejects if main moved, so an unlocked landing degrades to the
 * old race (a bounded re-attempt), never a bad push.
 */

const { parseMarkers } = require('./land-train');

const QUEUE_PREFIX = 'refs/land-mutex/queue/';
const LOCK_REF = 'refs/land-mutex/lock';
const GRACE_MS = 60 * 1000;
const STALE_AGE_MS = 150 * 60 * 1000; // > the longest life after enqueue: 75m wait + autonomous-merge's ~50m hold
// A live verdict is trusted this long: ~12 API calls/hour per waiter, so 8
// waiters stay well inside the shared 1000/hour GITHUB_TOKEN budget.
const LIVENESS_TTL_MS = 5 * 60 * 1000;
const POLL_MIN_MS = 10 * 1000;
const POLL_MAX_MS = 30 * 1000;
const DEADLINE_MINUTES = 75;
// BRO-5196: a Land job that sees PARK_DEPTH or more tickets ahead does not
// sleep-poll on its runner (14 deep on 2026-10-12 held 14 of the account's ~20
// runners and starved test.yml on main). Its first step cancels the run
// BEFORE any work, which is the "evicted while queued" state the sweep
// (land-retry-cancelled.js) already re-runs with rerun-failed-jobs, Checks
// result kept. The step name below is how a parked job is told apart from an
// eviction; land.yml's step must carry exactly this name.
const PARK_DEPTH = 4;
const PARK_STEP_NAME = 'Admit to the landing queue';
// The only Land step that pushes to main (land.js). Pinned to land.yml by land-mutex.test.mjs.
const LAND_STEP_NAME = 'Land the branch';
// BRO-6015: a resumed run (run_attempt > 1) parks only at PARK_DEPTH +
// RESUME_HEADROOM. With one threshold for both, fresh pushes (arriving every
// few minutes after their Checks job) took each freed slot before a resumed
// run reached its admit step, and 42 parked runs waited 3-5 h on 2026-10-22
// while their sessions re-pushed new refs. The headroom gives runs that
// already waited first claim on room; it also covers other attempt>1 runs
// (stranded full re-runs, hand re-runs), which are older work too. land.yml's
// admit step reads the same repo variable with the same default (pinned by
// land-mutex.test.mjs).
const RESUME_HEADROOM = 2;
// Parked runs resume only when the queue has room, so re-parks are rare; the
// budget is still bounded and stays below land-stranded-refs STRANDED_MAX_ATTEMPT.
const PARKED_MAX_ATTEMPTS = 15;
// Only tickets younger than this count toward the park depth. A live waiter's
// ticket is <= DEADLINE_MINUTES old (+ a lock hold); a dead run's leaked
// ticket is removed only by a live waiter, and when every arrival parks there
// is none, so leaked tickets must stop counting on their own.
const PARK_TICKET_MAX_AGE_MS = (75 + 15) * 60 * 1000;

const TICKET_RE = /^refs\/land-mutex\/queue\/([01])-(\d{13})-(\d+)-(\d+)$/;

function ticketName({ mainRed, enqueuedAt, runId, attempt }) {
  return `${QUEUE_PREFIX}${mainRed ? 0 : 1}-${String(enqueuedAt).padStart(13, '0')}-${runId}-${attempt}`;
}

function parseTicket(ref, sha) {
  const m = TICKET_RE.exec(ref || '');
  if (!m) return null;
  return { ref, sha, prio: Number(m[1]), enqueuedAt: Number(m[2]), runId: m[3], attempt: Number(m[4]) };
}

/**
 * `git ls-remote origin 'refs/land-mutex/*'` output → {tickets (queue order), lock, landed}.
 * landed: BRO-5282 merge-train markers, {<rider tip>: <its commit on main>}.
 */
function parseLsRemote(text) {
  const tickets = [];
  let lock = null;
  const landed = parseMarkers(text);
  for (const line of String(text || '').split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    if (ref === LOCK_REF) lock = { sha };
    else {
      const t = parseTicket(ref, sha);
      if (t) tickets.push(t);
    }
  }
  tickets.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { tickets, lock, landed };
}

const isSelf = (t, self) => Boolean(t && self) && t.runId === String(self.runId) && t.attempt === Number(self.attempt);

/**
 * A ticket's run (GET actions/runs/{id}), {status: 'missing'} for HTTP 404,
 * or null when unreadable → 'live' | 'gone'. Gone: the run finished, is missing,
 * or is on a newer attempt than the ticket's (the ticket's attempt died without
 * releasing). Unreadable: gone only past the age cap.
 */
function ticketLiveness(ticket, run, { now = Date.now(), staleAgeMs = STALE_AGE_MS } = {}) {
  if (run && typeof run === 'object' && run.status) {
    if (run.status === 'completed' || run.status === 'missing') return 'gone';
    if (Number(run.run_attempt || 1) > ticket.attempt) return 'gone';
    return 'live';
  }
  return now - ticket.enqueuedAt > staleAgeMs ? 'gone' : 'live';
}

/**
 * One poll's decision.
 *   state    — parseLsRemote() of this poll
 *   self     — {runId, attempt, tip?} (tip: the land/** tip this run's checks verified)
 *   liveness — (ref) => 'live' | 'gone' | undefined (cached API verdicts)
 *   stuck    — {ref, since}: the blocker (holder ticket ref, or LOCK_REF for an
 *              orphaned lock, or the head ticket ref) and when it was first seen
 *              blocking; the caller keeps it across polls
 * Returns {action, ...}:
 *   train-landed — BRO-5282: a merge train already landed self.tip (marker
 *                 ref present): withdraw our ticket and stop waiting
 *   enqueue     — no ticket of ours on the remote (first poll, or it was dropped)
 *   held        — the lock points at our ticket
 *   acquire     — no lock and our ticket is the head of the queue
 *   check       — `ticket` has blocked for GRACE_MS: look up its run
 *   break-lock  — the lock's holder is gone; delete LOCK_REF leased on `sha`
 *   drop-ticket — the head `ticket` (ahead of us) is gone; delete it leased on its sha
 *   wait        — `blocker` is ahead and live (or inside its grace)
 */
function decideStep({ state, self, liveness = () => undefined, stuck = null, now = Date.now(), graceMs = GRACE_MS } = {}) {
  const { tickets = [], lock = null, landed = {} } = state || {};
  if (self && self.tip && landed && landed[self.tip]) return { action: 'train-landed', sha: landed[self.tip] };
  const mine = tickets.find((t) => isSelf(t, self));
  if (!mine) return { action: 'enqueue' };
  const stuckLongEnough = (ref) => Boolean(stuck && stuck.ref === ref && now - stuck.since >= graceMs);

  if (lock) {
    if (lock.sha === mine.sha) return { action: 'held', ticket: mine };
    const holder = tickets.find((t) => t.sha === lock.sha);
    if (!holder) {
      // Orphaned: the holder's ticket was dropped while the lock stayed.
      if (stuckLongEnough(LOCK_REF)) return { action: 'break-lock', sha: lock.sha, reason: 'orphaned' };
      return { action: 'wait', blocker: { ref: LOCK_REF, sha: lock.sha }, reason: 'orphaned-lock-grace' };
    }
    const v = liveness(holder.ref);
    if (v === 'gone') return { action: 'break-lock', sha: lock.sha, holder, reason: 'holder-gone' };
    if (v === undefined && stuckLongEnough(holder.ref)) return { action: 'check', ticket: holder };
    return { action: 'wait', blocker: holder, reason: 'locked' };
  }

  const head = tickets[0];
  if (isSelf(head, self)) return { action: 'acquire', ticket: mine };
  const v = liveness(head.ref);
  if (v === 'gone') return { action: 'drop-ticket', ticket: head };
  if (v === undefined && stuckLongEnough(head.ref)) return { action: 'check', ticket: head };
  return { action: 'wait', blocker: head, reason: 'queued' };
}

/** The blocker ref a decision names (for the caller's `stuck` tracking). */
function blockerRef(decision) {
  if (!decision) return null;
  if (decision.action === 'wait') return decision.blocker.ref;
  if (decision.action === 'check') return decision.ticket.ref;
  return null;
}

/** Next poll delay: grows from POLL_MIN_MS to POLL_MAX_MS, ±20% jitter. */
function nextPollMs(poll, { rand = Math.random } = {}) {
  const base = Math.min(POLL_MAX_MS, POLL_MIN_MS * 1.5 ** Math.max(0, poll));
  return Math.round(base * (0.8 + 0.4 * rand()));
}

/**
 * Park depth from the repo variable (LAND_MUTEX_PARK_DEPTH), default PARK_DEPTH;
 * 0 disables, as does LAND_MUTEX_DISABLED=true (same kill switches as land.yml's
 * admit step, so the sweep never holds back a run the admit step would let in).
 */
function parkDepth(env = process.env) {
  if (env.LAND_MUTEX_DISABLED === 'true') return 0;
  const n = Number(env.LAND_MUTEX_PARK_DEPTH);
  return env.LAND_MUTEX_PARK_DEPTH !== undefined && env.LAND_MUTEX_PARK_DEPTH !== '' && Number.isInteger(n) && n >= 0 ? n : PARK_DEPTH;
}

/** Extra depth a resumed run may join at (LAND_MUTEX_RESUME_HEADROOM, default RESUME_HEADROOM). */
function resumeHeadroom(env = process.env) {
  const n = Number(env.LAND_MUTEX_RESUME_HEADROOM);
  return env.LAND_MUTEX_RESUME_HEADROOM !== undefined && env.LAND_MUTEX_RESUME_HEADROOM !== '' && Number.isInteger(n) && n >= 0 ? n : RESUME_HEADROOM;
}

/**
 * How many parked runs one sweep may resume (BRO-6015). A resumed run takes
 * no ticket until after its setup steps, so runs this sweep or an earlier one
 * already resumed (in flight at attempt > 1, no ticket yet) count against the
 * room, and one sweep resumes at most `headroom` runs (at least 1, so
 * LAND_MUTEX_RESUME_HEADROOM=0 is the old behavior: one per sweep below the
 * cap); otherwise every Land completion's sweep would see the same low depth
 * and over-admit. Unreadable queue (tickets null) or parking off: 1.
 */
function resumeSlots({ tickets, inflightResumedRunIds = [], cap, headroom, now = Date.now() }) {
  if (!tickets || !(cap > 0)) return 1;
  const ticketed = new Set(tickets.map((t) => String(t.runId)));
  const pending = [...new Set(inflightResumedRunIds.map(String))].filter((id) => !ticketed.has(id)).length;
  const room = cap + headroom - liveTicketCount(tickets, now) - pending;
  return Math.max(0, Math.min(Math.max(1, headroom), room));
}

/** Tickets that count toward the park depth: recent enough to belong to a live waiter. */
function liveTicketCount(tickets, now = Date.now()) {
  return (tickets || []).filter((t) => now - t.enqueuedAt <= PARK_TICKET_MAX_AGE_MS).length;
}

/**
 * Is this Land job (from the run's jobs listing) one that parked itself?
 * The admit step ended cancelled, nothing after it ran to completion, and
 * nothing failed: it never started landing.
 */
function isParkedLandJob(land) {
  const steps = (land && land.steps) || [];
  const admit = steps.find((x) => x.name === PARK_STEP_NAME);
  if (!admit || admit.conclusion !== 'cancelled') return false;
  // The runner's own bookkeeping steps succeed around any job; they are not work.
  const bookkeeping = (x) => x.name === 'Set up job' || x.name === 'Complete job';
  return steps.every((x) => x === admit || bookkeeping(x) || (x.conclusion !== 'success' && x.conclusion !== 'failure'));
}

/**
 * Did this Land job start landing (BRO-6291)? Setup steps and the mutex wait
 * succeed or get cancelled without touching main, and the always() cleanup
 * steps succeed after any cancel, so none of them count. Started = the
 * "Land the branch" step got any conclusion but skipped (cancelled counts:
 * land.js may have pushed half a train) or is still running. A job without
 * that step (unknown shape) keeps the old rule: any step that succeeded or
 * failed means started.
 */
function landWorkStarted(land) {
  const steps = (land && land.steps) || [];
  const landStep = steps.find((x) => x.name === LAND_STEP_NAME);
  if (!landStep) return steps.some((x) => x.conclusion === 'success' || x.conclusion === 'failure');
  if (landStep.conclusion) return landStep.conclusion !== 'skipped';
  return landStep.status === 'in_progress' || landStep.status === 'completed';
}

/** Our tickets in a state (release deletes every one, any attempt name drift aside). */
function ownTickets(state, self) {
  return ((state && state.tickets) || []).filter((t) => isSelf(t, self));
}

module.exports = {
  QUEUE_PREFIX, LOCK_REF, PARK_DEPTH, PARK_STEP_NAME, LAND_STEP_NAME, PARKED_MAX_ATTEMPTS, PARK_TICKET_MAX_AGE_MS, RESUME_HEADROOM, parkDepth, resumeHeadroom, resumeSlots, liveTicketCount, isParkedLandJob, landWorkStarted, GRACE_MS, STALE_AGE_MS, LIVENESS_TTL_MS, POLL_MIN_MS, POLL_MAX_MS, DEADLINE_MINUTES,
  ticketName, parseTicket, parseLsRemote, ticketLiveness, decideStep, blockerRef, nextPollMs, ownTickets,
};
