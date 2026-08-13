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
 *
 * claimLockGeneration/isLockGenerationOwner (#569) close a second race in the
 * same launcher: the 'reclaim-and-launch' path deletes+recreates LOCK_DIR
 * based on a stale in-memory decision, then writes meta.json well after
 * (preflight auth + up to ~150s of cmux launch time later). If the ORIGINAL
 * "dead" launch wasn't actually dead — just slow — it can reach its own
 * meta.json write after a newer generation has already reclaimed the same
 * directory, silently clobbering the new owner's meta with a stale
 * workspaceRef. Every claimant stamps a random token into the lock dir
 * immediately after its mkdir succeeds; every later destructive write
 * (meta.json, or the lock dir itself) must re-check that token is still
 * current before writing — the same ownership-check pattern
 * json-write-guard.js uses around commercial.json/audience-buzz.json saves.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function lockGenerationPath(lockDir) { return path.join(lockDir, 'generation.json'); }

/**
 * Stamps a fresh ownership token into lockDir. Must be called immediately
 * after the mkdir that created/reclaimed lockDir succeeds — before any other
 * operation — so the token is on disk before any slow work (auth preflight,
 * cmux launch) that a later reclaimer could race past.
 */
function claimLockGeneration(lockDir) {
  const token = crypto.randomUUID();
  fs.writeFileSync(lockGenerationPath(lockDir), JSON.stringify({
    token, pid: process.pid, claimedAt: new Date().toISOString(),
  }));
  return token;
}

/**
 * Whether `token` (returned by an earlier claimLockGeneration(lockDir) call)
 * still matches what's on disk. False means a newer generation has since
 * reclaimed the lock — the caller must not write meta.json or delete
 * lockDir, since either would stomp on the new owner.
 */
function isLockGenerationOwner(lockDir, token) {
  try {
    return JSON.parse(fs.readFileSync(lockGenerationPath(lockDir), 'utf8')).token === token;
  } catch {
    return false; // dir gone, generation file gone/corrupt — definitely not ours anymore
  }
}

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

// Consecutive no-change passes before the night stops relaunching. 3 x ~20-min
// ticks = ~45-60 min of provable silence for ~$15, versus the ~$135 an
// untouched window costs after the show is already covered. Deliberately the
// same number as MAX_ATTEMPTS_PER_NIGHT: both answer "how many times do we
// retry something that isn't working before we stop paying for it".
const MAX_NO_PROGRESS_PASSES = 3;

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The stored openingDate if it's a usable YYYY-MM-DD, else null. */
function storedAnchor(show) {
  return show.openingDate && DATE_RE.test(show.openingDate) ? show.openingDate : null;
}

/**
 * Fallback anchor from review evidence, for the show whose openingDate hasn't
 * been written yet.
 *
 * Root cause this exists for (how-the-other-half-loves-west-end-2026,
 * 2026-08-12): press night was Aug 12, reviews published Aug 12, but
 * `openingDate` stayed null until a later pipeline pass back-derived it from
 * those same reviews (`openingDateSource: review-derived-press-night`). The
 * window is computed from openingDate alone, so computeWindow returned null on
 * every launchd tick and the monitor opened 19 hours late — after the coverage
 * it exists to babysit had already landed. The evidence was there the whole
 * time: hasFreshEvidence() was true at 2026-08-12T16:00Z, the exact instant the
 * window should have opened. The launcher already loads it
 * (opening-night-monitor-launch.js, loadReviewEvidence for selection); it was
 * simply discarded one frame later, here.
 *
 * EARLIEST fresh item, not `.latest`: a roundup tail publishes for days after
 * press night, so `.latest` would re-anchor late every day — reintroducing the
 * same lateness it's meant to cure.
 *
 * Two clamps keep the anchor from sliding (a 6-day-old item must not anchor a
 * window 6 days in the past, then jump forward as it ages out and silently
 * re-key the night):
 *   - never before previewsStartDate — nothing published earlier can be a
 *     review of this production;
 *   - never more than ANCHOR_MAX_AGE_DAYS behind `now`.
 * A show whose evidence only survives outside those bounds gets no window,
 * which is the pre-existing behavior, not a regression.
 */
const ANCHOR_MAX_AGE_DAYS = 2;

function evidenceAnchor(show, evidence, now) {
  if (!evidence) return null;
  const e = evidence[show.id];
  if (!e || !Array.isArray(e.items) || !e.items.length) return null;

  const n = now instanceof Date ? now : new Date(now);
  const floorMs = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - ANCHOR_MAX_AGE_DAYS);
  const previews = show.previewsStartDate && DATE_RE.test(show.previewsStartDate)
    ? Date.parse(`${show.previewsStartDate}T00:00:00Z`) : null;

  let earliest = null;
  for (const it of e.items) {
    const d = it && typeof it.date === 'string' ? it.date.slice(0, 10) : null;
    if (!d || !DATE_RE.test(d)) continue;
    const ts = Date.parse(`${d}T00:00:00Z`);
    if (!Number.isFinite(ts)) continue;
    if (ts < floorMs) continue;                       // too old to anchor
    if (previews !== null && ts < previews) continue; // predates this production
    if (ts > n.getTime() + 2 * 3600 * 1000) continue; // future-dated (matches hasFreshEvidence)
    if (earliest === null || ts < earliest.ts) earliest = { ts, d };
  }
  return earliest && earliest.d;
}

/**
 * The monitor window for one show, or null if it isn't a press-night-market
 * show with a usable anchor date. Window: anchor 17:00 local-market time
 * → anchor+1 23:59 local-market time.
 *
 * The anchor is the stored openingDate when there is one, and review evidence
 * otherwise (see evidenceAnchor). `openingDate` on the returned window is the
 * ANCHOR, not necessarily show.openingDate — nightKey() and the activeWindows()
 * sort both read it and both need a real date string. `anchor` says which
 * source won, so a caller can tell a confirmed press night from an inferred one.
 *
 * @param {object} show
 * @param {object} [opts] { evidence: loadReviewEvidence() result, now: Date }
 */
function computeWindow(show, { evidence = null, now = new Date() } = {}) {
  const tz = MARKET_TZ[show.category];
  if (!tz) return null;
  const stored = storedAnchor(show);
  const anchorDate = stored || evidenceAnchor(show, evidence, now);
  if (!anchorDate) return null;
  return {
    showId: show.id,
    market: show.category,
    openingDate: anchorDate,
    anchor: stored ? 'openingDate' : 'evidence',
    windowStart: utcFromZoned(anchorDate, WINDOW_START_HOUR_LOCAL, 0, tz),
    windowEnd: utcFromZoned(nextDay(anchorDate), 23, 59, tz),
  };
}

/**
 * All shows whose monitor window contains `now`. Deliberately BROADER than
 * the orchestrator: openingDateSource trust and status are ignored (the
 * monitor exists to catch exactly the shows those gates skip — pass the
 * already-selected show objects from opening-night-selection.js with
 * {includeUntrusted: true, ignoreStatus: true}, or the raw shows array).
 */
function activeWindows(shows, now = new Date(), { evidence = null } = {}) {
  return shows
    .map(s => computeWindow(s, { evidence, now }))
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
 * Carry spend/attempt state across a mid-window night-key change.
 *
 * nightKey is derived from the window's anchor date, and an evidence anchor can
 * be superseded by the real openingDate landing mid-window (exactly the
 * back-derived-press-night case this file's evidence fallback exists for). If
 * the two dates differ the key flips, a fresh {attempts:0, usdTonight:0} state
 * is created, and BOTH brakes reset — NIGHTLY_USD_CAP and
 * MAX_ATTEMPTS_PER_NIGHT — so one night could spend twice its cap and re-fire
 * an escalation the owner already answered. The fix is to merge forward from
 * any prior state covering the same shows.
 *
 * Pure: the caller supplies the prior states and persists the result.
 *
 * @param {Array<{key:string, state:object}>} priorStates  all known night states
 * @param {string[]} shows  showIds in the current window
 * @param {object} current  state already loaded for the current key
 */
function carryForwardNightState(priorStates, shows, current = {}) {
  const showSet = new Set(shows);
  const merged = {
    attempts: current.attempts || 0,
    consecutiveFailures: current.consecutiveFailures || 0,
    noProgressPasses: current.noProgressPasses || 0,
    usdTonight: current.usdTonight || 0,
    escalated: Boolean(current.escalated),
  };
  let carriedFrom = null;
  for (const { key, state } of priorStates || []) {
    if (!state || !Array.isArray(state.shows)) continue;
    if (!state.shows.some(id => showSet.has(id))) continue;
    // Spend ACCUMULATES (it was really billed); the retry counters take the max
    // (they measure "how many times has this night tried", not a sum across
    // bookkeeping identities); escalated is sticky so a resolved escalation
    // never re-pages.
    merged.usdTonight = Math.round((merged.usdTonight + (state.usdTonight || 0)) * 100) / 100;
    merged.attempts = Math.max(merged.attempts, state.attempts || 0);
    merged.consecutiveFailures = Math.max(merged.consecutiveFailures, state.consecutiveFailures || 0);
    merged.noProgressPasses = Math.max(merged.noProgressPasses, state.noProgressPasses || 0);
    merged.escalated = merged.escalated || Boolean(state.escalated);
    carriedFrom = key;
  }
  if (carriedFrom) merged.carriedFrom = carriedFrom;
  return merged;
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
function launchDecision({ windows, killSwitch, lockExists, heartbeatAgeMin, claudeAlive, attemptsTonight, lockAgeSec = null, metaExists = true, noProgressPasses = 0 }) {
  if (killSwitch) return { action: 'skip', reason: 'kill switch active' };
  if (!windows.length) return { action: 'skip', reason: 'no show in its opening-night window' };
  // Diminishing-returns brake. NIGHTLY_USD_CAP only stops the night after $100
  // of opus passes; nothing stopped a *finished* show from burning the rest of
  // its ~31h window on passes that changed nothing (2026-08-12: a fully-covered
  // show had ~27 more $5 passes queued). Counting passes that produced neither
  // a session-state write nor a git commit is the market-agnostic version of
  // "there is nothing left to do" — it needs no census (the aggregator archive
  // is CI-populated and absent from the launchd checkout, so a census-based
  // stop would silently never fire here) and it degrades correctly whether the
  // show is complete or the pipeline is wedged.
  //
  // The counter RE-ARMS on new reviews (see launcher), so the long tail — a T1
  // dropping at 02:00 — still wakes the monitor. Without that this stop would
  // defeat the monitor's entire reason to exist.
  if (noProgressPasses >= MAX_NO_PROGRESS_PASSES) {
    return { action: 'escalate', reason: `${noProgressPasses} consecutive passes made no change (no state write, no commits) — nothing left to do this window` };
  }
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
  MAX_NO_PROGRESS_PASSES, ANCHOR_MAX_AGE_DAYS,
  tzOffsetMinutes, utcFromZoned, nextDay, computeWindow, activeWindows, nightKey, launchDecision,
  carryForwardNightState, evidenceAnchor,
  claimLockGeneration, isLockGenerationOwner, lockGenerationPath,
};
