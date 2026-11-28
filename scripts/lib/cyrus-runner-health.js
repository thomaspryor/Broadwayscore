'use strict';
/**
 * Verdict on the Cyrus runner fleet — spend and liveness guards — from the
 * status file the runner scheduler writes.
 *
 * Runners are the headless sessions that pick up auto-dispatched work. Two
 * failure modes hide from everyone until someone goes looking:
 *   1. RUNAWAY SPEND — a wedged runner burns API budget in a loop. Nothing
 *      stops new work from starting once the day's cap is blown, and the bill
 *      is the first anyone hears of it.
 *   2. SILENCE — the scheduler dies, or a runner stops checking in. No runner
 *      fires, work quietly stops moving, and there is no error to see: the
 *      absence of activity looks exactly like a quiet day.
 *
 * This mirrors scripts/lib/cyrus-relay-health.js on purpose: a pure assess()
 * the morning digest already knows how to render, plus a pure gate the runner
 * itself calls before starting work. The caller does the file read; these
 * functions take parsed state and an injectable clock so they test against
 * fixtures (CLAUDE.md rule 15 — the test require()s these, never a copy).
 *
 * State file shape (written by the scheduler each heartbeat, read by both the
 * digest and the runner gate), e.g. ~/.cyrus/runner-health.json:
 *   {
 *     "at": "2026-08-16T12:00:00.000Z",   // when this snapshot was written
 *     "capUSD": 25,                         // daily spend cap; absent = no cap
 *     "spentUSD": 12.5,                     // spend so far this window
 *     "runners": [                          // optional per-runner liveness
 *       { "id": "runner-a", "lastBeatAt": "2026-08-16T11:59:00.000Z" }
 *     ]
 *   }
 */

// The scheduler heartbeats continuously while alive (like the relay drain). A
// snapshot older than this means the scheduler is dead or wedged — no runner
// will fire — not merely that the fleet is idle. Well under a day so a
// scheduler that dies overnight surfaces in the next morning digest.
const STALE_STATUS_MS = 30 * 60 * 1000;

// A runner that claimed a slot but has not checked in for this long is hung,
// not working. Default when a runner record carries no expectedIntervalMs.
const RUNNER_STALE_MS = 60 * 60 * 1000;

// Warn as spend approaches the cap, before work is actually refused, so the
// cap being hit is never the first signal.
const SPEND_WARN_FRACTION = 0.9;

// Default spread for staggered quotas when a caller names no window.
const DEFAULT_STAGGER_WINDOW_MS = 15 * 60 * 1000;

/**
 * The budget cap gate. A runner calls this BEFORE starting new work; if spend
 * has reached the cap it must not start. Pure and clock-injectable so the
 * refusal is tested directly.
 *
 * A cap is never invented: with no capUSD configured (null/undefined/<=0) the
 * gate always allows — an absent cap must not silently freeze the fleet.
 *
 * @param {object|null} state parsed runner-health.json, or null if absent
 * @returns {{refuse:boolean, reason:string|null, spentUSD:number, capUSD:number|null}}
 */
function refuseNewWork(state) {
  const capUSD = state && Number(state.capUSD) > 0 ? Number(state.capUSD) : null;
  const spentUSD = Number(state && state.spentUSD) || 0;
  if (capUSD === null) {
    return { refuse: false, reason: null, spentUSD, capUSD: null };
  }
  if (spentUSD >= capUSD) {
    return {
      refuse: true,
      reason: `runner spend $${spentUSD.toFixed(2)} has reached the $${capUSD.toFixed(2)} daily cap — not starting new work`,
      spentUSD,
      capUSD,
    };
  }
  return { refuse: false, reason: null, spentUSD, capUSD };
}

/**
 * Digest verdict for the runner fleet: over-budget and dead-heartbeat surface
 * here so a human sees them daily. Mirrors assessCyrusRelay's contract exactly
 * — same status set, same "absent is unknown, never an alarm" rule — so the
 * sender renders it with no new code.
 *
 * @param {object|null} state parsed runner-health.json, or null if absent
 * @param {number} nowMs
 * @returns {{status:'ok'|'warn'|'error'|'unknown', message:string|null}}
 */
function assessRunnerHealth(state, nowMs = Date.now()) {
  if (state === null || state === undefined) {
    // Absent on machines that don't run runners — unknown, never an alarm.
    return { status: 'unknown', message: null };
  }

  const writtenMs = Date.parse(state.at);
  if (!Number.isFinite(writtenMs)) {
    return { status: 'error', message: 'Cyrus runners: status file is unreadable — the scheduler may not be running.' };
  }

  // Silence: the scheduler stopped writing. This is the "missing heartbeat"
  // the acceptance is about — no runner is firing and nothing else would say so.
  const ageMin = Math.round((nowMs - writtenMs) / 60000);
  if (nowMs - writtenMs > STALE_STATUS_MS) {
    return {
      status: 'error',
      message: `Cyrus runners: the scheduler has not checked in for ${ageMin} min — no runner is picking up work. Restart: launchctl kickstart -k gui/$(id -u)/com.broadwayscore.cyrus-runner`,
    };
  }

  // Runaway spend: the cap was hit, so the gate is now refusing new work.
  const { refuse } = refuseNewWork(state);
  const capUSD = Number(state.capUSD) > 0 ? Number(state.capUSD) : null;
  const spentUSD = Number(state.spentUSD) || 0;
  if (refuse) {
    return {
      status: 'warn',
      message: `Cyrus runners: daily spend cap of $${capUSD.toFixed(2)} reached ($${spentUSD.toFixed(2)} spent) — new work is being refused until the window resets.`,
    };
  }
  if (capUSD !== null && spentUSD >= capUSD * SPEND_WARN_FRACTION) {
    return {
      status: 'warn',
      message: `Cyrus runners: $${spentUSD.toFixed(2)} of the $${capUSD.toFixed(2)} daily cap spent — approaching the limit.`,
    };
  }

  // Individual runner that claimed a slot but went dark.
  const dark = (Array.isArray(state.runners) ? state.runners : [])
    .map((r) => {
      const beatMs = Date.parse(r && r.lastBeatAt);
      const staleMs = Number(r && r.expectedIntervalMs) > 0 ? Number(r.expectedIntervalMs) : RUNNER_STALE_MS;
      const isStale = !Number.isFinite(beatMs) || nowMs - beatMs > staleMs;
      return isStale ? { id: (r && r.id) || 'unknown', ageMin: Number.isFinite(beatMs) ? Math.round((nowMs - beatMs) / 60000) : null } : null;
    })
    .filter(Boolean);
  if (dark.length > 0) {
    const detail = dark
      .map((d) => (d.ageMin === null ? `${d.id} (never)` : `${d.id} (${d.ageMin} min)`))
      .join(', ');
    return {
      status: 'warn',
      message: `Cyrus runners: ${dark.length} runner${dark.length === 1 ? '' : 's'} claimed a slot but stopped checking in — ${detail}. They may be hung.`,
    };
  }

  return { status: 'ok', message: null };
}

/**
 * Staggered quotas: a stable per-runner offset into a firing window, so a
 * fleet of runners on the same schedule does not all fire at the same instant
 * (which stampedes the API, the git lock, and the dispatch ledger at once).
 *
 * Deterministic — the same runnerId always maps to the same offset, so a
 * runner's slot is stable across restarts — and pure (no clock, no I/O). The
 * caller adds the returned offset to the top of its window before firing.
 *
 * @param {string} runnerId
 * @param {number} [windowMs=DEFAULT_STAGGER_WINDOW_MS] width of the firing window
 * @returns {number} offset in [0, windowMs)
 */
function staggerDelayMs(runnerId, windowMs = DEFAULT_STAGGER_WINDOW_MS) {
  const window = Number(windowMs) > 0 ? Math.floor(Number(windowMs)) : DEFAULT_STAGGER_WINDOW_MS;
  const id = String(runnerId == null ? '' : runnerId);
  // FNV-1a: a small, stable, dependency-free string hash. Only stability and
  // spread matter here, not cryptographic strength.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % window;
}

module.exports = {
  refuseNewWork,
  assessRunnerHealth,
  staggerDelayMs,
  STALE_STATUS_MS,
  RUNNER_STALE_MS,
  SPEND_WARN_FRACTION,
  DEFAULT_STAGGER_WINDOW_MS,
};
