/**
 * ScrapingBee daily circuit breaker (BRO-3010, spend-guards Sprint 2) — the
 * SB twin of scrapingdog-caps.js / check-sd-breaker.js, landing in SHADOW mode.
 *
 * Why: SB is a prepaid monthly pack (1,000,000 credits, renewal around the
 * 4th-5th). It ran dry before renewal twice in a row (2026-09-04 at 1,000,010
 * and 2026-10-03 at 1,000,005, per data/audit/provider-spend-daily.jsonl), so
 * a runaway sweep early in the cycle starves the last days. The existing
 * guards do not cover that: SB_CREDIT_BUDGET is per RUN (a runaway guard, kept
 * as-is — never derive per-run budgets from the pack, there is no run-count
 * denominator), and checkScrapingBeeCredits only stops on near-exhaustion.
 *
 * Shape, reusing the SD maths rather than copying it:
 *   - today's credits: scrapingdog-caps.computeTodayCredits (SB's /usage is
 *     cycle-cumulative too; same rollover, gap and renewal-clamp rules);
 *   - ceiling: scrapingdog-caps.planFairShareCeiling on the pack (cap minus
 *     usage at day start, over days to renewal, x SB_BREAKER_BURST_FACTOR);
 *     SB_BREAKER_CEILING pins it; DEFAULT_DAILY_CREDIT_CEILING when /usage
 *     lacks the cap or renewal date.
 *
 * SHADOW (SB_BREAKER_SHADOW unset or anything but '0', the default): the
 * checker records `wouldTripAt` and never sets `trippedAt`, so
 * consultScrapingbee() — which blocks only on trippedAt — cannot block.
 *
 * ENFORCED (SB_BREAKER_SHADOW=0), LOOSEN-ONLY: the breaker is never allowed to
 * be tighter than normal demand. The effective ceiling is
 * max(plan ceiling after the opening-window reserve, 1.5 x the trailing 14-day
 * median of SB dayCredits); with no usable demand history (fewer than 7 clean days) it
 * does not enforce at all. Note the median can therefore override the
 * opening-window reserve on a normal-demand day — intended: the reserve only
 * bites when the plan ceiling is ABOVE normal demand. The same floor is
 * applied in SHADOW, so the shadow record is what enforcement would do. (The
 * opening-window reserve itself is capped at half the ceiling since BRO-5247,
 * so it can no longer zero the ceiling.) Exhausted-pack days
 * (cycleUsed >= cap) are excluded from the median, and they never count as a
 * would-trip (SB lets a few credits through past the cap, which is not a
 * runaway).
 *
 * Enforcement chokepoints: scraper.js fetchWithScrapingBee (returns null, so
 * fetchPage's chain moves on) and url-discovery.js's regular SB SERP call.
 * Deliberately UNGATED: url-discovery's _serpTypedViaScrapingBee (news/images
 * — SB is the only provider there, so gating means feature loss, not
 * rerouting), and the low-volume direct callers reddit-api.js,
 * site-search-discovery.js, backfill-cast-web.js, check-cookie-health.js and
 * scraper.js's second direct call. SB is the LAST paid tier: unlike SD, a
 * block here means Playwright/Browserbase or nothing, which is part of the
 * S2-T9 decision to leave shadow mode.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const {
  computeTodayCredits, shouldTripBreaker, isBreakerActive, planFairShareCeiling,
} = require('./scrapingdog-caps');
const { utcDay, isExemptCaller, DEFAULT_EXEMPT_SCRIPTS } = require('./brightdata-caps');

/** Fallback ceiling when /usage lacks cap or renewal date: ~1.5 x (1M / 30). */
const DEFAULT_DAILY_CREDIT_CEILING = 50000;
const DEFAULT_FAIR_SHARE_BURST_FACTOR = 1.5;
/** Same per-show reserve as SD (credit-denominated, similar daily scale). */
const DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS = 3000;
const MEDIAN_WINDOW_DAYS = 14;
const MEDIAN_MIN_SAMPLES = 7;
/**
 * The loosen-only floor is this multiple of the 14-day median (BRO-3010
 * review). A floor AT the median would trip on roughly half of all normal
 * days by definition; the spend-guard audit (BRO-3011, guard-audit-core
 * DRIFT_FACTOR) calls a ceiling under 1.5x median demand cap drift and more
 * than 2 trip days a week a defect, so the two rules use the same 1.5.
 */
const MEDIAN_FLOOR_FACTOR = 1.5;
const DEFAULT_STATE_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'sb-circuit-breaker.json');
const STATE_CACHE_MS = 60_000;

function _posInt(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Shadow unless SB_BREAKER_SHADOW is exactly '0'. */
function resolveShadow(env = process.env) {
  return String(env.SB_BREAKER_SHADOW == null ? '' : env.SB_BREAKER_SHADOW).trim() !== '0';
}

function resolveOpeningWindowReservePerShowCredits(env = process.env) {
  return _posInt(env.SB_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS, DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS);
}

function resolveExemptScripts(env = process.env) {
  const raw = (env.SB_EXEMPT_SCRIPTS || '').trim();
  if (!raw) return DEFAULT_EXEMPT_SCRIPTS.slice();
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Whole days from `day` (YYYY-MM-DD) to the renewal date (YYYY-MM-DD prefix of
 * /usage renewal_subscription_date). null when missing/unparseable or already
 * past (an expired pack is not "renews today" — same rule SD applies).
 */
function daysToRenewal(renewalDate, day) {
  if (typeof renewalDate !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(renewalDate)) return null;
  const r = Date.parse(`${renewalDate.slice(0, 10)}T00:00:00Z`);
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(r) || !Number.isFinite(t)) return null;
  const d = Math.round((r - t) / 86400000);
  return d < 0 ? null : d;
}

/**
 * Ceiling with provenance. Precedence: SB_BREAKER_CEILING > plan fair share >
 * default. `usage` is provider-billing.parseSbUsage's shape or null.
 * @returns {{ceiling: number, source: 'env'|'plan'|'default'}}
 */
function resolveCeilingForDay({ env = process.env, usage = null, dayBaseline = null, day } = {}) {
  const envCeiling = _posInt(env.SB_BREAKER_CEILING, null);
  if (envCeiling !== null) return { ceiling: envCeiling, source: 'env' };
  const burstRaw = parseFloat(env.SB_BREAKER_BURST_FACTOR);
  const burstFactor = Number.isFinite(burstRaw) && burstRaw > 0 ? burstRaw : DEFAULT_FAIR_SHARE_BURST_FACTOR;
  const baseline = Number.isFinite(dayBaseline) ? dayBaseline : (usage && Number.isFinite(usage.cycleUsed) ? usage.cycleUsed : null);
  const plan = usage ? planFairShareCeiling({
    limit: usage.cap,
    dayBaseline: baseline,
    daysToRenewal: daysToRenewal(usage.renewalDate, day),
    burstFactor,
  }) : null;
  if (plan !== null) return { ceiling: plan, source: 'plan' };
  return { ceiling: DEFAULT_DAILY_CREDIT_CEILING, source: 'default' };
}

/**
 * Trailing median of clean SB dayCredits from provider-spend-daily.jsonl rows,
 * over the MEDIAN_WINDOW_DAYS days strictly before `day`. Clean = status 'ok',
 * numeric dayCredits, and NOT an exhausted-pack day (cycleUsed >= cap, where
 * the count is cut short by the cap). Deduped by day (union-merged JSONL can
 * repeat a day; the latest capturedAt wins). null below MEDIAN_MIN_SAMPLES.
 */
function trailingMedianDayCredits(rows, day, { windowDays = MEDIAN_WINDOW_DAYS, minSamples = MEDIAN_MIN_SAMPLES } = {}) {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const since = new Date(t - windowDays * 86400000).toISOString().slice(0, 10);
  const byDay = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.day !== 'string' || r.day >= day || r.day < since) continue;
    const sb = r.providers && r.providers.scrapingbee;
    if (!sb || sb.status !== 'ok' || typeof sb.dayCredits !== 'number' || !Number.isFinite(sb.dayCredits)) continue;
    if (Number.isFinite(sb.cap) && Number.isFinite(sb.cycleUsed) && sb.cycleUsed >= sb.cap) continue;
    const prev = byDay.get(r.day);
    if (!prev || String(r.capturedAt || '') >= String(prev.capturedAt || '')) byDay.set(r.day, { capturedAt: r.capturedAt, v: sb.dayCredits });
  }
  const vals = [...byDay.values()].map((x) => x.v).sort((a, b) => a - b);
  if (vals.length < minSamples) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
}

/**
 * Would enforcement apply today, and at what ceiling? Pure.
 * @returns {{enforce: boolean, effectiveCeiling: number, ceilingSource: string, reason: string}}
 */
function enforcementDecision({ shadow, ceiling, ceilingSource, median }) {
  // The loosen-only floor applies in SHADOW too, so the shadow record shows
  // exactly what enforcement would do (a reserve-zeroed ceiling of 0 would
  // otherwise read as "no ceiling" and make the shadow week useless).
  const floor = Number.isFinite(median) ? Math.round(median * MEDIAN_FLOOR_FACTOR) : null;
  const floored = floor != null && !(ceiling >= floor);
  const effectiveCeiling = floored ? floor : ceiling;
  const source = floored ? `${ceilingSource}+median-floor` : ceilingSource;
  if (!Number.isFinite(median)) {
    return { enforce: false, effectiveCeiling, ceilingSource: source, reason: shadow ? 'shadow' : 'no-demand-history (fewer than 7 clean days)' };
  }
  if (shadow) return { enforce: false, effectiveCeiling, ceilingSource: source, reason: 'shadow' };
  return {
    enforce: true, effectiveCeiling, ceilingSource: source,
    reason: floored ? `loosen-only: ceiling ${ceiling} < ${MEDIAN_FLOOR_FACTOR}x 14d median ${median}, enforcing ${floor}` : 'enforced',
  };
}

/** provider-spend-daily.jsonl rows (the median's source); [] when unreadable. Read-only. */
const DEFAULT_DAILY_SPEND_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'provider-spend-daily.jsonl');
function loadDailySpendRows(p = process.env.PROVIDER_SPEND_DAILY_PATH || DEFAULT_DAILY_SPEND_PATH) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Exhausted pack: SB lets a few credits through past the cap — not a runaway. */
function isPackExhausted(usage) {
  return Boolean(usage && Number.isFinite(usage.cap) && Number.isFinite(usage.cycleUsed) && usage.cycleUsed >= usage.cap);
}

/** Shadow analogue of isBreakerActive: a would-trip recorded for TODAY. */
function isShadowActive(state, day) {
  if (!state || typeof state !== 'object') return false;
  return state.day === day && state.wouldTripAt != null;
}

// ---------- stateful consult (the enforcement helper) ------------------------

const _runStats = { blocked: 0, blockedByBreaker: 0 };
let _stateCache = { at: 0, value: null };
let _loggedBlock = false;

function _statePath(env = process.env) {
  return env.SB_BREAKER_STATE_PATH || DEFAULT_STATE_PATH;
}

function readBreakerState(env = process.env, now = Date.now()) {
  if (_stateCache.value !== null && _stateCache.at <= now && now - _stateCache.at < STATE_CACHE_MS) return _stateCache.value;
  let value = null;
  try { value = JSON.parse(fs.readFileSync(_statePath(env), 'utf8')); } catch { value = {}; }
  _stateCache = { at: now, value };
  return value;
}

/**
 * Same contract as consultScrapingdog. Blocks only on an ENFORCED trip for
 * today (state.trippedAt); a shadow state (wouldTripAt only) never blocks.
 * @returns {{allowed: boolean, exempt: boolean, reason?: string, firstBlock?: boolean}}
 */
function consultScrapingbee({ env = process.env, now = new Date() } = {}) {
  if (env.SB_CAPS_DISABLED === '1') return { allowed: true, exempt: true, reason: 'caps-disabled' };
  const scriptName = (() => {
    try { return process.argv[1] ? path.basename(process.argv[1]) : null; } catch { return null; }
  })();
  const exempt = isExemptCaller(scriptName, resolveExemptScripts(env), env.GITHUB_WORKFLOW || null, env.BD_OPENING_NIGHT || null);
  if (exempt) return { allowed: true, exempt: true };
  const state = readBreakerState(env, Date.now());
  if (isBreakerActive(state, utcDay(now))) {
    _runStats.blocked++;
    _runStats.blockedByBreaker++;
    const firstBlock = !_loggedBlock;
    if (firstBlock) {
      console.log(`  ⚠️  ScrapingBee daily breaker tripped (${state.dayCredits} credits vs ceiling ${state.ceiling}) — skipping SB for non-opening-night calls`);
      _loggedBlock = true;
    }
    return { allowed: false, exempt: false, reason: 'breaker', firstBlock };
  }
  return { allowed: true, exempt: false };
}

function getScrapingbeeCapStats() {
  return { ..._runStats };
}

function _resetForTests() {
  _runStats.blocked = 0;
  _runStats.blockedByBreaker = 0;
  _stateCache = { at: 0, value: null };
  _loggedBlock = false;
}

module.exports = {
  DEFAULT_DAILY_CREDIT_CEILING,
  DEFAULT_FAIR_SHARE_BURST_FACTOR,
  DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS,
  DEFAULT_STATE_PATH,
  MEDIAN_WINDOW_DAYS,
  MEDIAN_MIN_SAMPLES,
  MEDIAN_FLOOR_FACTOR,
  resolveShadow,
  resolveOpeningWindowReservePerShowCredits,
  resolveExemptScripts,
  daysToRenewal,
  resolveCeilingForDay,
  trailingMedianDayCredits,
  loadDailySpendRows,
  enforcementDecision,
  isPackExhausted,
  isShadowActive,
  computeTodayCredits,
  shouldTripBreaker,
  isBreakerActive,
  readBreakerState,
  consultScrapingbee,
  getScrapingbeeCapStats,
  _resetForTests,
};
