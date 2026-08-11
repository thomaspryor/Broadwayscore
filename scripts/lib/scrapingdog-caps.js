/**
 * ScrapingDog daily circuit breaker (card #1252 — the SD half of the
 * BrightData/ScrapingDog "no real-time spend enforcement" gap).
 *
 * BrightData already has this: scripts/lib/brightdata-caps.js's
 * consultBrightData(), backed by an hourly billing-API check
 * (scripts/check-bd-breaker.js) that writes data/audit/bd-circuit-breaker.json.
 * This file is the SD equivalent, reusing that architecture as closely as
 * SD's different API shape allows — see computeTodayCredits() below for the
 * one real divergence.
 *
 * Existing SD guards this does NOT replace:
 *   - SD_CREDIT_BUDGET (scraper.js) — per-RUN budget, resets every process.
 *   - shouldSkipScrapingdogAtRuntime (scrapingdog-ack.js) — trips ONLY on
 *     TRUE account exhaustion (remaining <= 0); deliberately not a pace
 *     guard (routing to BD at ~17x cost while paid SD credits sit idle
 *     caused a real $50 auto-recharge incident, 2026-07-26).
 * Neither stops a runaway job well BEFORE true exhaustion — that is the gap
 * this file closes: a cross-run DAILY ceiling, enforced before a call is
 * made, not just reported the next morning by check-provider-spend.js.
 *
 * Two chokepoints (mirrors BD's two-chokepoint doctrine — brightdata-caps.js
 * L269-277 — enforcing at the outer fetchPage()/fetchJSON() gate was
 * explicitly rejected there because plenty of call paths reach a provider
 * without passing through those wrappers):
 *   1. scraper.js fetchWithScrapingdog() — the page-fetch tier.
 *   2. url-discovery.js _serpViaScrapingdog() — a separate direct API call,
 *      exactly parallel to BD's _serpViaBrightData.
 * Known gap (documented, not fixed here — out of scope for this card):
 * scripts/lib/reddit-api.js's fetchViaScrapingDog() is a third, independent
 * SD caller with its own tier/retry logic; not gated.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { utcDay, isExemptCaller, DEFAULT_EXEMPT_SCRIPTS } = require('./brightdata-caps');
const { isNextUtcDay } = require('./provider-spend-core');

/**
 * Daily credit ceiling default — matches scripts/config/provider-spend-thresholds.json's
 * scrapingdogDailyCredits (owner-approved 2026-07-30 alarm line). Kept as its
 * OWN constant rather than reading that JSON file at call time: scraper.js is
 * a hot path, and thresholds.json is documented as digest-only config. Same
 * pattern brightdata-caps.js uses (its own DEFAULT_DAILY_REQ_CEILING is a
 * separate constant from thresholds.json's brightdataDailyUsd). If the two
 * numbers drift, that is a known, accepted cost of the split — update both
 * when changing the intended daily budget.
 */
const DEFAULT_DAILY_CREDIT_CEILING = 45000;

const DEFAULT_STATE_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'sd-circuit-breaker.json');
const STATE_CACHE_MS = 60_000;

function _posInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Daily credit ceiling: SD_BREAKER_CEILING, else the shared default. */
function resolveDailyCreditCeiling(env = process.env) {
  return _posInt(env.SD_BREAKER_CEILING, DEFAULT_DAILY_CREDIT_CEILING);
}

/**
 * Exempt-script allowlist: SD_EXEMPT_SCRIPTS (comma-separated) overrides,
 * else BD's own list (imported, not copied — same scripts do opening-night
 * discovery for both providers).
 */
function resolveExemptScripts(env = process.env) {
  const raw = (env.SD_EXEMPT_SCRIPTS || '').trim();
  if (!raw) return DEFAULT_EXEMPT_SCRIPTS.slice();
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------- pure decision functions ------------------------------------------

/**
 * Has today's credit usage crossed the ceiling?
 * @param {{dayCredits: number|null, ceiling: number}} params
 * @returns {{tripped: boolean, reason: string}}
 *
 * dayCredits === null means the day's usage is unmeasurable right now (no
 * billing data, or a 'baseline'/cold-start/gap day per computeTodayCredits).
 * That is UNKNOWN, never zero and never "over" — fail-open, mirroring
 * brightdata-caps.js's shouldTripBreaker exactly.
 */
function shouldTripBreaker({ dayCredits, ceiling }) {
  if (typeof dayCredits !== 'number' || !Number.isFinite(dayCredits)) {
    return { tripped: false, reason: 'unknown-billing' };
  }
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    return { tripped: false, reason: 'no-ceiling' };
  }
  if (dayCredits >= ceiling) {
    return { tripped: true, reason: `day credits ${dayCredits} >= ceiling ${ceiling}` };
  }
  return { tripped: false, reason: `day credits ${dayCredits} < ceiling ${ceiling}` };
}

/**
 * Derive today's credit usage from SD's account reading, which (unlike BD's
 * billing API) only exposes CYCLE-cumulative requestUsed
 * (provider-billing.js's parseSdAccount -> cycleUsed), not a per-day figure.
 *
 * This mirrors provider-spend-core.js's cycleDelta() — which solves the
 * identical problem for the once-daily digest by diffing against
 * YESTERDAY's snapshot — adapted for hourly LIVE polling: the baseline is
 * carried forward from the LAST reading recorded before the day rolled
 * over, never reset to "whatever the first reading of today happens to be".
 * Resetting to the first-of-day reading would open a blind window: GHA cron
 * schedules run 30min-3h late (memory/feedback_github_cron_delays.md), so a
 * burst right after UTC midnight — before the delayed first check of the
 * new day — would be silently folded into the new baseline and never
 * counted toward the ceiling.
 *
 * @param {{cycleUsed: number|null, day: string}} reading - current account
 *   reading (cycleUsed) and "today" (YYYY-MM-DD UTC)
 * @param {{day: string, dayBaseline: number, lastCycleUsed: number}|null} prevState
 *   the persisted state from the last check (any day), or null if none yet
 * @returns {{dayCredits: number|null, status: 'ok'|'baseline'|'unknown',
 *            newState: {day: string, dayBaseline: number, lastCycleUsed: number}|null}}
 */
function computeTodayCredits({ cycleUsed, day, prevState }) {
  if (typeof cycleUsed !== 'number' || !Number.isFinite(cycleUsed)) {
    // Unknown reading (billing API unreachable) — leave any prior state
    // untouched so the NEXT good reading can still diff against it.
    return { dayCredits: null, status: 'unknown', newState: prevState || null };
  }

  let dayBaseline;
  let status = 'ok';

  if (!prevState) {
    // Cold start — nothing to diff against yet. 'baseline', not a false
    // trip, mirrors cycleDelta's treatment of a first-ever record.
    dayBaseline = cycleUsed;
    status = 'baseline';
  } else if (prevState.day === day) {
    dayBaseline = prevState.dayBaseline;
  } else if (isNextUtcDay(prevState.day, day)) {
    // Rolled over exactly one day — carry forward YESTERDAY's last reading.
    dayBaseline = prevState.lastCycleUsed;
  } else {
    // Gap of more than one day (missed cron runs): a delta across the gap
    // would false-attribute several days' usage to one. Degrade to
    // 'baseline' rather than risk a bogus trip (cycleDelta's gap rule).
    dayBaseline = cycleUsed;
    status = 'baseline';
  }

  // Counter went DOWN since the baseline was set → the billing cycle itself
  // renewed mid-window. The new cycle's running total IS today's usage
  // (cycleDelta's "counter reset = cycle renewed" rule) — clamping the
  // baseline to 0 makes the diff below fall out correctly for this AND
  // every later same-day read.
  if (cycleUsed < dayBaseline) dayBaseline = 0;

  const dayCredits = Math.max(0, cycleUsed - dayBaseline);
  return {
    dayCredits: status === 'ok' ? dayCredits : null,
    status,
    newState: { day, dayBaseline, lastCycleUsed: cycleUsed },
  };
}

/**
 * Is the persisted breaker state blocking calls right now? Day-scoped: a
 * state file left behind from yesterday must not keep blocking today, even
 * if the hourly clearing job missed a run.
 * @param {object|null} state - parsed sd-circuit-breaker.json
 * @param {string} day - "YYYY-MM-DD" UTC
 */
function isBreakerActive(state, day) {
  if (!state || typeof state !== 'object') return false;
  return state.day === day && state.trippedAt != null;
}

// ---------- stateful consult (the single enforcement helper) -----------------

const _runStats = { blocked: 0, blockedByBreaker: 0 };
let _stateCache = { at: 0, value: null };
let _loggedBlock = false;

function _statePath(env = process.env) {
  return env.SD_BREAKER_STATE_PATH || DEFAULT_STATE_PATH;
}

/** Read + cache the breaker state file. Any read/parse failure = no breaker. */
function readBreakerState(env = process.env, now = Date.now()) {
  if (_stateCache.value !== null && now - _stateCache.at < STATE_CACHE_MS) {
    return _stateCache.value;
  }
  let value = null;
  try {
    value = JSON.parse(fs.readFileSync(_statePath(env), 'utf8'));
  } catch {
    value = {};
  }
  _stateCache = { at: now, value };
  return value;
}

/**
 * THE enforcement helper. Called from exactly the two SD chokepoints
 * (scraper.js fetchWithScrapingdog(), url-discovery.js _serpViaScrapingdog())
 * — see the module docstring.
 *
 * Blocking here returns {allowed:false}; callers return null so fetchPage()'s
 * existing fallback chain (SD -> BD -> SB -> Playwright) routes around it.
 * This is deliberately SOFT — not an account-wide hard failure — because,
 * unlike Browserbase or BD's own last-tier position, SD always has a next
 * tier to fall through to.
 *
 * Exempt callers (opening-night scripts) reuse BD_OPENING_NIGHT and BD's
 * script/workflow allowlist signals (isExemptCaller is provider-agnostic —
 * it just answers "is this call part of an active opening-night flow") so
 * that during a live opening-night sweep, SD calls are NOT forced to fall
 * through to BD on every request — which would itself push BD toward ITS
 * OWN breaker faster, recreating the exact outage BD's own exemption exists
 * to prevent, one hop downstream.
 *
 * @param {{env?: object, now?: Date}} [params]
 * @returns {{allowed: boolean, exempt: boolean, reason?: string, firstBlock?: boolean}}
 */
function consultScrapingdog({ env = process.env, now = new Date() } = {}) {
  if (env.SD_CAPS_DISABLED === '1') {
    return { allowed: true, exempt: true, reason: 'caps-disabled' };
  }

  const scriptName = (() => {
    try { return process.argv[1] ? path.basename(process.argv[1]) : null; } catch { return null; }
  })();
  const exempt = isExemptCaller(
    scriptName,
    resolveExemptScripts(env),
    env.GITHUB_WORKFLOW || null,
    env.BD_OPENING_NIGHT || null,
  );
  if (exempt) return { allowed: true, exempt: true };

  const state = readBreakerState(env, Date.now());
  const day = utcDay(now);
  if (isBreakerActive(state, day)) {
    _runStats.blocked++;
    _runStats.blockedByBreaker++;
    const firstBlock = !_loggedBlock;
    if (firstBlock) {
      console.log(`  ⚠️  Scrapingdog daily breaker tripped (${state.dayCredits} credits vs ceiling ${state.ceiling}) — skipping SD for non-opening-night calls`);
      _loggedBlock = true;
    }
    return { allowed: false, exempt: false, reason: 'breaker', firstBlock };
  }

  return { allowed: true, exempt: false };
}

/** Per-run counters — sdBlockedByBreaker lets a caller (e.g. scraper.js's
 * getScraperStats()) tell "blocked by the day cap" apart from other misses. */
function getScrapingdogCapStats() {
  return { ..._runStats };
}

/** Test-only: reset module state between cases. */
function _resetForTests() {
  _runStats.blocked = 0;
  _runStats.blockedByBreaker = 0;
  _stateCache = { at: 0, value: null };
  _loggedBlock = false;
}

module.exports = {
  DEFAULT_DAILY_CREDIT_CEILING,
  DEFAULT_STATE_PATH,
  resolveDailyCreditCeiling,
  resolveExemptScripts,
  shouldTripBreaker,
  computeTodayCredits,
  isBreakerActive,
  readBreakerState,
  consultScrapingdog,
  getScrapingdogCapStats,
  _resetForTests,
};
