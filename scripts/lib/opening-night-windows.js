/**
 * opening-night-windows — pure decision logic for the local opening-night
 * monitor launcher (scripts/opening-night-monitor-launch.js): market-local
 * curtain-time windows and the launch/no-launch decision table.
 *
 * Split out per CLAUDE.md §15 (test extraction): every branch here is
 * unit-tested in opening-night-windows.test.mjs, including the highest-risk
 * path — a session SLEEPING between census passes has no running claude
 * process, and a naive point-in-time liveness probe would relaunch a
 * duplicate Fable session into the same working tree (plan-review pre-mortem
 * primary scenario). Liveness is therefore heartbeat-file freshness first,
 * process probe second.
 */

// Press-night markets only: OB/OWE open "cold" (no press night; the
// orchestrator anchors them to previewsStartDate) so there is no single
// curtain time to babysit — the standing pipeline + gap audits own those.
const MARKET_TZ = {
  broadway: 'America/New_York',
  'west-end': 'Europe/London',
};

// Window shape: reviews for a press night drop from early evening local time
// (WE embargoes often lift ~19:00-22:00 UK; Broadway ~21:30-23:00 ET) through
// the following day (tier-2/3 outlets publish next morning/afternoon). 17:00
// local start gives the monitor time for Phase-0 preflight before the first
// drops; end of openingDate+1 covers the morning-after long tail. Beyond
// that, the standing 21-day pipeline (orchestrator pollMode daily/every-3d)
// owns discovery.
const WINDOW_START_HOUR_LOCAL = 17;

// Minutes of heartbeat silence before a locked session is presumed dead
// ENOUGH to consult the process probe. The monitor loop writes the heartbeat
// every pass (max gap by design: 60-min quiet-phase cadence) — 90 gives one
// full quiet cycle plus slack for a long tool call.
const HEARTBEAT_STALE_MIN = 90;

// External brake (plan-review: the $100 soft cap is self-policed by the very
// session that might be stuck — the launcher enforces a hard attempt count
// outside it). 3 matches dispatch-ledger's DEAD_ATTEMPT_LIMIT convention.
const MAX_ATTEMPTS_PER_NIGHT = 3;

// LOCK_META (meta.json) is written only AFTER launchCmuxSession() returns —
// up to verifyTimeoutSec(90) x 2 attempts + lateAdoptSec(60) = ~240s of real
// launch time, plus overhead. A concurrent tick that sees the lock with no
// meta yet is indistinguishable from "session died before ever writing meta"
// UNLESS it also knows how old the lock is: younger than this grace window
// means a launch is actively in flight (#568, same failure class as
// #559/#564/#567 but a write-ordering race, not a liveness-signal one) —
// older means it really did die before establishing itself and is safe to
// reclaim. Shares monitor-lock-staleness.js's LAUNCH_GRACE_MS (a sibling
// helper solving a related but distinct question — "should the nightly
// executor skip because a monitor might be active" vs this file's "should
// THIS tick reclaim the lock") so the two launch-grace policies can't drift
// apart (ship-check finding, ~2026-07-26).
const { LAUNCH_GRACE_MS } = require('./monitor-lock-staleness.js');
const LAUNCH_INFLIGHT_GRACE_SEC = LAUNCH_GRACE_MS / 1000;

/** Offset of `tz` from UTC in minutes at instant `date` (DST-correct). */
function tzOffsetMinutes(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}

/** UTC instant of `dateStr` (YYYY-MM-DD) at hh:mm local time in `tz`. */
function utcFromZoned(dateStr, hour, minute, tz) {
  const base = Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  // Two passes converge across DST transitions: the first guess's offset may
  // be from the wrong side of the change; recomputing at the corrected
  // instant lands on the right one.
  let guess = new Date(base);
  for (let i = 0; i < 2; i++) {
    guess = new Date(base - tzOffsetMinutes(guess, tz) * 60000);
  }
  return guess;
}

/** YYYY-MM-DD string for the day after dateStr (pure calendar math, UTC-safe). */
function nextDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`); // noon avoids any day-boundary edge
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The monitor window for one show, or null if it isn't a press-night-market
 * show with a real openingDate. Window: openingDate 17:00 local-market time
 * → openingDate+1 23:59 local-market time.
 */
function computeWindow(show) {
  const tz = MARKET_TZ[show.category];
  if (!tz || !show.openingDate || !/^\d{4}-\d{2}-\d{2}$/.test(show.openingDate)) return null;
  return {
    showId: show.id,
    market: show.category,
    openingDate: show.openingDate,
    windowStart: utcFromZoned(show.openingDate, WINDOW_START_HOUR_LOCAL, 0, tz),
    windowEnd: utcFromZoned(nextDay(show.openingDate), 23, 59, tz),
  };
}

/**
 * All shows whose monitor window contains `now`. Deliberately BROADER than
 * the orchestrator: openingDateSource trust and status are ignored (the
 * monitor exists to catch exactly the shows those gates skip — pass the
 * already-selected show objects from opening-night-selection.js with
 * {includeUntrusted: true, ignoreStatus: true}, or the raw shows array).
 */
function activeWindows(shows, now = new Date()) {
  return shows
    .map(computeWindow)
    .filter(Boolean)
    .filter(w => w.windowStart <= now && now <= w.windowEnd)
    .sort((a, b) => a.openingDate.localeCompare(b.openingDate) || a.showId.localeCompare(b.showId));
}

/**
 * Stable per-night key for the attempt ledger and lock: the earliest active
 * openingDate. Consecutive-day openings share overlapping windows and hence
 * one live session (the session re-derives its active-show list every loop
 * pass, so a show entering its window mid-session is picked up without a
 * second launch).
 */
function nightKey(windows) {
  return windows.length ? `on-monitor-${windows[0].openingDate}` : null;
}

/**
 * The launch decision table. Pure — the launcher supplies observed state.
 *
 * @param {object} state
 * @param {Array}   state.windows          activeWindows() result
 * @param {boolean} state.killSwitch       DISABLED file or repo var present
 * @param {boolean} state.lockExists       night lock dir present
 * @param {number|null} state.heartbeatAgeMin  minutes since the locked session's
 *                                         heartbeat write; null = no heartbeat file
 * @param {boolean} state.claudeAlive      point-in-time process probe of the locked
 *                                         session's workspace
 * @param {number}  state.attemptsTonight  ledger count of launches for nightKey
 * @param {number|null} [state.lockAgeSec] seconds since LOCK_DIR was created (mkdir
 *                                         birthtime); null/omitted = unknown
 * @param {boolean} [state.metaExists]     LOCK_META (meta.json) has been written for
 *                                         THIS lock instance; default true (safe:
 *                                         unknown callers get the pre-#568 behavior)
 * @returns {{action: 'skip'|'launch'|'reclaim-and-launch'|'escalate', reason: string}}
 */
function launchDecision({ windows, killSwitch, lockExists, heartbeatAgeMin, claudeAlive, attemptsTonight, lockAgeSec = null, metaExists = true }) {
  if (killSwitch) return { action: 'skip', reason: 'kill switch active' };
  if (!windows.length) return { action: 'skip', reason: 'no show in its opening-night window' };
  if (lockExists) {
    // Heartbeat freshness OUTRANKS the process probe: a session sleeping
    // between census passes (ScheduleWakeup pacing) has no running claude
    // process but a recent heartbeat — relaunching onto it is the duplicate-
    // session clobber scenario. Only stale-heartbeat AND no-process counts
    // as dead.
    if (heartbeatAgeMin !== null && heartbeatAgeMin < HEARTBEAT_STALE_MIN) {
      return { action: 'skip', reason: `live session (heartbeat ${Math.round(heartbeatAgeMin)}m ago)` };
    }
    if (claudeAlive) {
      return { action: 'skip', reason: 'live session (process probe; heartbeat stale — long tool call?)' };
    }
    // meta.json has never been written for THIS lock instance — it (and the
    // heartbeat) are only written after launchCmuxSession() returns, so this
    // is exactly the state a concurrent tick sees while a launch is still in
    // flight. This must key off metaExists, NOT heartbeatAgeMin===null: the
    // heartbeat file is a single global path (not scoped to this lock) that
    // a prior night's session already wrote and never gets deleted, so
    // heartbeatAgeMin is realistically always a large stale number, never
    // null (ship-check finding, 2026-07-26 — the original heartbeat-based
    // check was unreachable in production). A lock younger than its own
    // worst-case launch time is not evidence of death; only treat it as
    // reclaimable once it's outlasted that window (#568).
    if (!metaExists && lockAgeSec !== null && lockAgeSec < LAUNCH_INFLIGHT_GRACE_SEC) {
      return { action: 'skip', reason: `lock is ${Math.round(lockAgeSec)}s old, no meta.json yet — launch likely still in flight` };
    }
    if (attemptsTonight >= MAX_ATTEMPTS_PER_NIGHT) {
      return { action: 'escalate', reason: `session dead and ${attemptsTonight} attempts already spent tonight` };
    }
    return { action: 'reclaim-and-launch', reason: 'locked session dead (stale heartbeat + no process)' };
  }
  if (attemptsTonight >= MAX_ATTEMPTS_PER_NIGHT) {
    return { action: 'escalate', reason: `${attemptsTonight} attempts already spent tonight` };
  }
  return { action: 'launch', reason: 'show in window, no live session' };
}

module.exports = {
  MARKET_TZ, WINDOW_START_HOUR_LOCAL, HEARTBEAT_STALE_MIN, MAX_ATTEMPTS_PER_NIGHT, LAUNCH_INFLIGHT_GRACE_SEC,
  tzOffsetMinutes, utcFromZoned, nextDay, computeWindow, activeWindows, nightKey, launchDecision,
};
