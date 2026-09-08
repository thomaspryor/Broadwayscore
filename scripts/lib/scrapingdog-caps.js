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
 * LEGACY daily credit ceiling — since BRO-2943 (2026-09-07) this is only the
 * fallback used when the Scrapingdog /account response is unreachable or is
 * missing the plan limit / days-to-renewal; the enforced ceiling is otherwise
 * plan-derived (see planFairShareCeiling / resolveCeilingForDay below). It
 * historically matched scripts/config/provider-spend-thresholds.json's
 * scrapingdogDailyCredits alarm line (owner-approved 2026-07-30); that digest
 * line is owner-owned and deliberately NOT changed here, so the digest may
 * flag "overspend" on days the breaker intentionally allows. Kept as its OWN
 * constant rather than reading that JSON at call time: scraper.js is a hot
 * path and thresholds.json is digest-only config (same split as
 * brightdata-caps.js's DEFAULT_DAILY_REQ_CEILING vs brightdataDailyUsd).
 */
const DEFAULT_DAILY_CREDIT_CEILING = 45000;

/**
 * Per-show reservation carved OUT of the daily ceiling for bulk (non-exempt)
 * callers whenever a show is in its opening window (#1330, the SD half of
 * #1315's BD fix — the same flat-ceiling starvation gap: countShowsInOpeningWindow
 * was already computed in check-sd-breaker.js for alert-severity labeling, but
 * never fed into the ceiling itself, so a routine sweep could exhaust the same
 * day's SD credits an opening-window show's review-day scraping needed).
 *
 * No observed-incident number exists yet for SD the way BD had (554 unlocker
 * calls billed 2026-08-02) — SD's per-request cost varies by tier (1 credit
 * standard, 5 render, 10 premium; SERP calls bill 5*attempts, url-discovery.js)
 * so a request-count reserve doesn't translate directly into a credit reserve.
 * Sized proportionally to BD's own reserve-to-ceiling ratio instead (250 /
 * 3,500 ≈ 7.1% of BD's per-zone daily ceiling) applied to SD's daily ceiling —
 * the same "throttle bulk sweeps well before the real breaker trips" intent,
 * scaled to SD's larger credit-denominated budget. Recalibrate alongside
 * DEFAULT_PER_SHOW in opening-night-budget.js once a real opening-window SD
 * credit figure is observed (memory/opening-night-budget-tuning.md).
 */
const DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS = 3000;

/**
 * Burst multiplier on the plan-derived fair share (BRO-2943). The prepaid
 * pack's per-day fair share is (credits left at day start) / (days to
 * renewal); a routine day sits well under it and a burst day (bulk backfill,
 * several opening nights) can run ~2x. 1.5x lets bursts through while still
 * shrinking toward the fair share when the pack is genuinely running low —
 * the ONLY case where withholding prepaid SD credits is cheaper than paying
 * Bright Data (17x) / ScrapingBee SERP (5x) for the rest of the day.
 */
const DEFAULT_FAIR_SHARE_BURST_FACTOR = 1.5;

const DEFAULT_STATE_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'sd-circuit-breaker.json');
const STATE_CACHE_MS = 60_000;

function _posInt(raw, fallback) {
  // Number() + isInteger, not parseInt: parseInt('1e5') is 1, which turned
  // an operator's "100,000" pin into a ceiling of ONE credit (ship-check
  // finding). Non-integer, negative, empty or garbage → fallback.
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Daily credit ceiling: SD_BREAKER_CEILING, else the shared default. */
function resolveDailyCreditCeiling(env = process.env) {
  return _posInt(env.SD_BREAKER_CEILING, DEFAULT_DAILY_CREDIT_CEILING);
}

/**
 * Plan-derived daily ceiling (BRO-2943): the prepaid pack's fair share for
 * today, times a burst factor, clamped to what is actually left.
 *
 *   remaining = limit - dayBaseline          (credits unspent at day start)
 *   ceiling   = min(round(remaining / max(daysToRenewal, 1) * burst), remaining)
 *
 * Why this replaces the hardcoded 45,000: the pack silently went 4M -> 3M
 * and demand is ~50K/day, so a fixed number is either wrong on day one or
 * wrong after the next plan change. Measured 2026-09-07: the 45K line (minus
 * the opening-window reserve) tripped by mid-morning most days and rerouted
 * routine SERP/page traffic to Bright Data + ScrapingBee — ~900K+ ScrapingBee
 * credits per cycle attributed to nothing else. Returns null when any input
 * is unusable so the caller can fall back (env override, then the legacy
 * default) — never a NaN/0 that shouldTripBreaker would read as "no ceiling".
 */
function planFairShareCeiling({ limit, dayBaseline, daysToRenewal, burstFactor = DEFAULT_FAIR_SHARE_BURST_FACTOR } = {}) {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (!Number.isFinite(dayBaseline) || dayBaseline < 0) return null;
  // A negative validity is an expired/grace-period pack, not "renews today":
  // treating it as 1 day would license the whole remainder in one day
  // (Codex ship-check finding; scrapingdog-ack.js rejects negatives too).
  if (!Number.isFinite(daysToRenewal) || daysToRenewal < 0) return null;
  if (!Number.isFinite(burstFactor) || burstFactor <= 0) return null;
  const remaining = Math.max(0, limit - dayBaseline);
  // Pack spent (or downgraded below what is already used): a ceiling of 1
  // trips on the first credit. shouldTripBreaker() reads 0 as "no ceiling"
  // and would fail OPEN — the wrong direction for an exhausted pack.
  if (remaining <= 0) return 1;
  const fairShare = remaining / Math.max(daysToRenewal, 1);
  return Math.max(1, Math.min(Math.round(fairShare * burstFactor), remaining));
}

/**
 * The ceiling check-sd-breaker.js should enforce today, with its provenance.
 * Precedence: SD_BREAKER_CEILING env override (operator pin) > plan fair
 * share (needs the /account limit + days-to-renewal AND today's baseline) >
 * legacy DEFAULT_DAILY_CREDIT_CEILING. `account` is parseSdAccount()'s shape
 * ({cycleUsed, limit, daysToRenewal}) or null when billing was unreachable.
 * @returns {{ceiling: number, source: 'env'|'plan'|'default'}}
 */
function resolveCeilingForDay({ env = process.env, account = null, dayBaseline = null } = {}) {
  const envCeiling = _posInt(env.SD_BREAKER_CEILING, null);
  if (envCeiling !== null) return { ceiling: envCeiling, source: 'env' };
  const baseline = Number.isFinite(dayBaseline) ? dayBaseline : (account && Number.isFinite(account.cycleUsed) ? account.cycleUsed : null);
  // SD_BREAKER_BURST_FACTOR: rollback/tuning knob for the 1.5x default
  // without a code change (garbage/non-positive → default).
  const burstRaw = parseFloat(env.SD_BREAKER_BURST_FACTOR);
  const burstFactor = Number.isFinite(burstRaw) && burstRaw > 0 ? burstRaw : DEFAULT_FAIR_SHARE_BURST_FACTOR;
  const plan = account ? planFairShareCeiling({
    limit: account.limit,
    dayBaseline: baseline,
    daysToRenewal: account.daysToRenewal,
    burstFactor,
  }) : null;
  if (plan !== null) return { ceiling: plan, source: 'plan' };
  return { ceiling: DEFAULT_DAILY_CREDIT_CEILING, source: 'default' };
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

/** Opening-window per-show credit reserve: SD_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS, else the default. */
function resolveOpeningWindowReservePerShowCredits(env = process.env) {
  return _posInt(env.SD_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS, DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS);
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
  DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS,
  DEFAULT_FAIR_SHARE_BURST_FACTOR,
  DEFAULT_STATE_PATH,
  resolveDailyCreditCeiling,
  planFairShareCeiling,
  resolveCeilingForDay,
  resolveExemptScripts,
  resolveOpeningWindowReservePerShowCredits,
  shouldTripBreaker,
  computeTodayCredits,
  isBreakerActive,
  readBreakerState,
  consultScrapingdog,
  getScrapingdogCapStats,
  _resetForTests,
};
