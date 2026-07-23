/**
 * Circuit breaker for the T1 silent-gap self-heal refetch loop
 * (Sprint 3 S3-T1, sprint-plan-t1-retrieval.md).
 *
 * WHY THIS EXISTS:
 * audit-t1-silent-gaps.js already re-ingests empty-body T1 files from their own
 * URL (recoverFromOwnUrl). Today that spend is bounded only by a per-RUN
 * --fetch-cap and a per-FILE aggUrlRecoveryCount stored in the review JSON.
 * There is NO ceiling on how many refetches happen per UTC DAY across the many
 * hourly runs — a back-catalogue full of cap-not-yet-reached empty stubs could
 * fan out unbounded scraper calls (this repo has hit 1000+ runs/day cascades:
 * memory/feedback_workflow_cascade_prevention.md). ScrapingBee is also exhausted
 * until 2026-08-05, so every refetch routes through fetchPage()'s remaining
 * chain — a hard daily cap is the guard.
 *
 * DESIGN (serp-session-cap.js / serp-burst-caps.js pattern):
 *  - checkRefetchAllowed() is a PURE decision fn of concrete counts, so the cap
 *    logic is unit-testable and production code requires it (change the fn, the
 *    test fails).
 *  - The state lives ONLY in data/audit/t1-recovery-state.json — the audit side
 *    of the pipeline — NEVER in per-review JSON. Per-review counters (the legacy
 *    aggUrlRecoveryCount) are a SEPARATE, older mechanism; this breaker adds a
 *    global daily budget + an audit-side per-file attempt history on top of it,
 *    keyed by `showId/fileName`.
 *  - Single writer: only audit-t1-silent-gaps.js (the hourly job) mutates the
 *    state file, read-modify-write, committed by that workflow.
 *
 * COUNTER SEMANTICS:
 *  - globalCount resets each UTC day (rolloverDay). It bounds total refetches/day.
 *  - per-file attempts DO NOT reset — a permanently-dead URL stops after
 *    perFileCap tries forever (mirrors aggUrlRecoveryCount, which never resets).
 *    perFileCap defaults to FLAGGED_RECOVERY_CAP so the two caps agree.
 *
 * Pure decision + pure state mutators; the only fs touch is load/save wrappers.
 */

'use strict';

const fs = require('fs');
const { FLAGGED_RECOVERY_CAP } = require('./flagged-recovery');

const DEFAULT_REFETCH_CONFIG = {
  // Global ceiling: at most this many self-heal refetches per UTC day, across
  // ALL shows and files. Sized small on purpose — the T1 in-window gap set is
  // a handful of files at a time; 10/day heals a fresh opening's stuck reviews
  // over a few hours without ever approaching a cascade. Bump only with a
  // deliberate cost review.
  dailyGlobalCap: 10,
  // Per-file ceiling: at most this many refetch attempts for one showId/file,
  // ever (non-resetting). Matches FLAGGED_RECOVERY_CAP so a file that hit the
  // per-review retry cap and a file that hit the audit-side cap agree.
  perFileCap: FLAGGED_RECOVERY_CAP,
};

// UTC day key (YYYY-MM-DD) for the daily-global rollover. Injectable clock.
function utcDayKey(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

// Stable state-file key for a file's attempt history. showId + fileName is the
// natural key (the same file can exist under many shows); never the review URL
// (byline-explosion clusters share one URL across many files).
function fileKey(showId, fileName) {
  return `${showId}/${fileName}`;
}

// Fresh, empty state. `day` is the UTC day globalCount applies to.
function emptyState(now = new Date()) {
  return { day: utcDayKey(now), globalCount: 0, files: {} };
}

/**
 * Roll the global counter over to the current UTC day if the stored day is
 * stale. Returns a NEW state object (never mutates input). Per-file history is
 * preserved across the rollover — only the daily global budget resets.
 */
function rolloverDay(state, now = new Date()) {
  const today = utcDayKey(now);
  const base = state && typeof state === 'object' ? state : emptyState(now);
  const files = base.files && typeof base.files === 'object' ? base.files : {};
  if (base.day === today) {
    return { day: today, globalCount: base.globalCount || 0, files };
  }
  return { day: today, globalCount: 0, files };
}

/**
 * How many refetch attempts this file has already logged (audit-side).
 * @param {object} state - the recovery-state object (post-rollover or raw)
 * @param {string} showId
 * @param {string} fileName
 * @returns {number}
 */
function fileAttempts(state, showId, fileName) {
  const files = (state && state.files) || {};
  const entry = files[fileKey(showId, fileName)];
  return (entry && entry.attempts) || 0;
}

/**
 * PURE decision: may a self-heal refetch run right now?
 *
 * Checks the global daily cap BEFORE the per-file cap (a single file can't be
 * told "you're fine" when the day's budget is already spent — mirrors the
 * serp-burst-caps ordering). This does NOT decide whether the file is
 * merge-safe / worth recovering — decideEmptyBodyRecovery owns that and runs
 * first; this is purely the spend ceiling consulted just before the fetch.
 *
 * @param {object} p
 * @param {number} p.globalToday  - refetches already used today (post-rollover globalCount)
 * @param {number} p.attempts     - refetch attempts already logged for THIS file
 * @param {object} [p.config]     - cap config (defaults to DEFAULT_REFETCH_CONFIG)
 * @returns {{allowed: boolean, reason: string, limit?: number, used?: number}}
 */
function checkRefetchAllowed({ globalToday, attempts, config = DEFAULT_REFETCH_CONFIG }) {
  const g = Number.isFinite(globalToday) ? globalToday : 0;
  const a = Number.isFinite(attempts) ? attempts : 0;
  if (g >= config.dailyGlobalCap) {
    return { allowed: false, reason: 'daily-global-cap', limit: config.dailyGlobalCap, used: g };
  }
  if (a >= config.perFileCap) {
    return { allowed: false, reason: 'per-file-cap', limit: config.perFileCap, used: a };
  }
  return { allowed: true, reason: 'ok' };
}

/**
 * Convenience wrapper: roll the day over, then decide, reading the file's
 * attempt count from the state. Returns { allowed, reason, state } where
 * `state` is the post-rollover state (caller should persist it if it will
 * record an attempt). Does NOT mutate the passed state or record anything.
 */
function decideRefetch(state, { showId, fileName, now = new Date(), config = DEFAULT_REFETCH_CONFIG } = {}) {
  const rolled = rolloverDay(state, now);
  const decision = checkRefetchAllowed({
    globalToday: rolled.globalCount,
    attempts: fileAttempts(rolled, showId, fileName),
    config,
  });
  return { ...decision, state: rolled };
}

/**
 * Record ONE refetch attempt: bump the global daily counter and the file's
 * attempt history. Returns a NEW state object (never mutates input). The caller
 * MUST persist this after EVERY attempt — success OR failure — or a permanently
 * blocked URL never hits its cap (same discipline as aggUrlRecoveryCount).
 */
function recordRefetch(state, { showId, fileName, now = new Date() } = {}) {
  const rolled = rolloverDay(state, now);
  const files = { ...rolled.files };
  const key = fileKey(showId, fileName);
  const prev = files[key] || { attempts: 0 };
  files[key] = {
    attempts: (prev.attempts || 0) + 1,
    lastAttemptAt: new Date(now).toISOString(),
  };
  return { day: rolled.day, globalCount: (rolled.globalCount || 0) + 1, files };
}

// --- thin I/O wrappers (the only fs touch) --------------------------------

function loadRecoveryState(statePath, now = new Date()) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    // Normalize shape but DO NOT roll the day here — callers roll explicitly so
    // a read for reporting doesn't silently reset the stored day.
    if (raw && typeof raw === 'object') {
      return {
        day: raw.day || utcDayKey(now),
        globalCount: raw.globalCount || 0,
        files: raw.files && typeof raw.files === 'object' ? raw.files : {},
      };
    }
  } catch { /* missing / unparseable → fresh */ }
  return emptyState(now);
}

function saveRecoveryState(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

module.exports = {
  DEFAULT_REFETCH_CONFIG,
  utcDayKey,
  fileKey,
  emptyState,
  rolloverDay,
  fileAttempts,
  checkRefetchAllowed,
  decideRefetch,
  recordRefetch,
  loadRecoveryState,
  saveRecoveryState,
};
