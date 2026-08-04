/**
 * Bright Data daily circuit breaker + per-run request budget.
 *
 * Scraping cost v3 S2 (card 3b1637c5, owner-approved plan T3). Bright Data hit
 * $13.48/day on 2026-08-02 with no ceiling of any kind: the only spend guards
 * were per-run credit budgets on the OTHER two providers (SD/SB), so a runaway
 * bulk sweep could bill BD indefinitely.
 *
 * Two independent mechanisms, deliberately separate:
 *
 *   1. DAILY BREAKER (cross-run). An hourly job (scripts/check-bd-breaker.js)
 *      asks BD's own billing API how many requests each zone actually billed
 *      today and writes data/audit/bd-circuit-breaker.json when a zone is over
 *      its ceiling. Every BD call then consults that file. The count comes from
 *      BILLING, never from our own ledger: 5 of 6 plan reviewers independently
 *      flagged ledger-based counting as a P0 — the ledger is written by many
 *      concurrent CI writers (read-modify-write, task #788) and only ~1% of BD
 *      SERP calls are attributed at all, so a ledger-counted cap would simply
 *      never trip.
 *
 *   2. PER-RUN BUDGET (in-process). BD_REQ_BUDGET mirrors SD_CREDIT_BUDGET:
 *      a single runaway run stops billing before the hourly breaker can even
 *      observe it. 0 = unlimited (the default; bulk workflows opt in).
 *
 * OPENING NIGHT IS EXEMPT FROM BOTH, with its OWN allowance. The carve-out is
 * not a label on a shared counter (another review finding — a shared counter
 * with an exempt label still lets bulk traffic exhaust the pool the poller
 * needs): exempt callers count against exemptUsed/BD_REQ_BUDGET_OPENING_NIGHT,
 * and their daily bound is opening-night-budget.js's `brightdata` resource,
 * checked pre-flight per shift. Review-collection latency on opening night must
 * never regress because a backfill overspent at 3am.
 *
 * Pure decision functions are exported separately from the stateful consult so
 * brightdata-caps.test.mjs can exercise every branch with concrete inputs and
 * zero mocks (pattern: browserbase-caps.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * THE per-zone daily request ceiling. One constant, one edit site — the same
 * rationale browserbase-caps.js documents: two enforcement points
 * (fetchWithBrightData for the unlocker zone, _serpViaBrightData for the SERP
 * zone) cap the SAME BD account, and a second hard-coded literal would silently
 * leave half the spend uncapped after a step-down.
 *
 * Sizing: 2026-08-02 (the incident day) billed ~4,600 unlocker + ~3,900 SERP
 * requests for $13.48. 3,500/zone/day bounds the pair at roughly $7/day, which
 * is the card's acceptance target, while sitting comfortably above every
 * observed NORMAL day (2026-07-28..08-01 peaked at 2,050 unlocker requests).
 * The breaker is meant to catch runaways, not to shape normal traffic — step it
 * down only after the "never trips on a normal day" RECHECK in the card.
 */
const DEFAULT_DAILY_REQ_CEILING = 3500;

/**
 * Callers exempt from the breaker + bulk budget. Matched on the basename of
 * process.argv[1]. Deliberately minimal (plan: "start allowlist minimal") —
 * these are the scripts that do live opening-night review discovery, where a
 * blocked BD call means a missed review on the one day it matters.
 *
 * The script list alone is NOT sufficient: opening-night-poller.yml also runs
 * collect-review-texts.js --aggressive (line 441) as part of the same
 * opening-night chain, and that script is very deliberately NOT exempt when a
 * bulk backfill invokes it. isExemptCaller therefore also honors the workflow
 * name, which distinguishes the two invocations of the identical script.
 */
const DEFAULT_EXEMPT_SCRIPTS = Object.freeze([
  'opening-night-poller.js',
  'discover-opening-night-reviews.js',
  'check-opening-night-completeness.js',
]);

/** GITHUB_WORKFLOW values that make every step of the run exempt. */
const EXEMPT_WORKFLOW_PREFIX = 'opening night';

const DEFAULT_STATE_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'bd-circuit-breaker.json');

/** Breaker file is re-read at most this often per process (mtime-cached). */
const STATE_CACHE_MS = 60_000;

// ---------- pure resolvers (garbage-safe, mirroring browserbase-caps) --------

/**
 * Positive-integer env parse with fallback. Garbage/negative/zero fall back
 * rather than silently disabling the cap (parseInt('') === NaN) or pinning it
 * at 0 (which would block every call).
 */
function _posInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Daily per-zone ceiling: BD_BREAKER_CEILING, else the shared default. */
function resolveDailyCeiling(env = process.env) {
  return _posInt(env.BD_BREAKER_CEILING, DEFAULT_DAILY_REQ_CEILING);
}

/**
 * Per-run request budget for NON-exempt (bulk) callers. 0 = unlimited, which
 * is both the default and a legitimate explicit value — unlike the ceiling,
 * `BD_REQ_BUDGET=0` must mean "no per-run cap", so 0 is honored here.
 */
function resolvePerRunBudget(env = process.env) {
  const n = parseInt(env.BD_REQ_BUDGET, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Per-run request budget for exempt (opening-night) callers. Separate pool. */
function resolveExemptPerRunBudget(env = process.env) {
  const n = parseInt(env.BD_REQ_BUDGET_OPENING_NIGHT, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Exempt-script allowlist: BD_EXEMPT_SCRIPTS (comma-separated) overrides. */
function resolveExemptScripts(env = process.env) {
  const raw = (env.BD_EXEMPT_SCRIPTS || '').trim();
  if (!raw) return DEFAULT_EXEMPT_SCRIPTS.slice();
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------- pure decision functions ------------------------------------------

/**
 * Has this zone billed past its ceiling today?
 * @param {{billedReqs: number|null, ceiling: number}} params
 * @returns {{tripped: boolean, reason: string}}
 *
 * billedReqs === null means the billing API was unreachable. That is UNKNOWN,
 * never zero and never "over" — fail-open, matching provider-billing.js's
 * documented rule. A breaker that trips on an API hiccup would starve the whole
 * pipeline for an hour over a network blip.
 */
function shouldTripBreaker({ billedReqs, ceiling }) {
  if (typeof billedReqs !== 'number' || !Number.isFinite(billedReqs)) {
    return { tripped: false, reason: 'unknown-billing' };
  }
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    return { tripped: false, reason: 'no-ceiling' };
  }
  if (billedReqs >= ceiling) {
    return { tripped: true, reason: `billed ${billedReqs} >= ceiling ${ceiling}` };
  }
  return { tripped: false, reason: `billed ${billedReqs} < ceiling ${ceiling}` };
}

/**
 * Is this caller exempt from the breaker + bulk budget?
 * @param {string|null} scriptName - basename of process.argv[1]
 * @param {string[]} allowlist
 * @param {string|null} [workflowName] - GITHUB_WORKFLOW
 */
function isExemptCaller(scriptName, allowlist, workflowName = null) {
  if (typeof workflowName === 'string'
      && workflowName.trim().toLowerCase().startsWith(EXEMPT_WORKFLOW_PREFIX)) {
    return true;
  }
  if (typeof scriptName !== 'string' || !scriptName) return false;
  const base = scriptName.includes('/') ? scriptName.slice(scriptName.lastIndexOf('/') + 1) : scriptName;
  return (allowlist || []).includes(base);
}

/**
 * Per-run budget check. budget <= 0 means unlimited.
 * @returns {{allowed: boolean, used: number, limit: number, reason?: string}}
 */
function checkPerRunBudget({ used, budget }) {
  const u = Number.isFinite(used) ? used : 0;
  if (!Number.isFinite(budget) || budget <= 0) {
    return { allowed: true, used: u, limit: 0 };
  }
  if (u >= budget) {
    return { allowed: false, used: u, limit: budget, reason: `per-run BD budget exhausted (${u}/${budget})` };
  }
  return { allowed: true, used: u, limit: budget };
}

/**
 * Is the persisted breaker state blocking this zone right now?
 *
 * Day-scoped on purpose: a state file left behind from yesterday must NOT keep
 * blocking today, even if the hourly clearing job missed a run. The breaker
 * bounds spend per UTC day, so a stale entry expires with its day.
 *
 * @param {object|null} state - parsed bd-circuit-breaker.json
 * @param {{zone: string, day: string}} params - day as "YYYY-MM-DD" (UTC)
 */
function isBreakerActiveForZone(state, { zone, day }) {
  const entry = state && state.zones && state.zones[zone];
  if (!entry || typeof entry !== 'object') return false;
  return entry.day === day && entry.trippedAt != null;
}

/** "YYYY-MM-DD" for a Date, in UTC. */
function utcDay(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Alert severity for a breaker state change. A trip during an active opening
 * window is materially worse than one at 3am on a quiet Tuesday: exempt flows
 * keep running, but the owner needs to know immediately that bulk collection
 * for a live show is capped.
 * @param {{tripped: boolean, openingWindowShows: number}} params
 */
function breakerAlertSeverity({ tripped, openingWindowShows }) {
  if (!tripped) return 'info';
  return openingWindowShows > 0 ? 'critical' : 'warn';
}

// ---------- stateful consult (the single enforcement helper) -----------------

const _runStats = {
  bulkUsed: 0,
  exemptUsed: 0,
  blocked: 0,
  blockedByBreaker: 0,
  blockedByBudget: 0,
};

let _stateCache = { at: 0, value: null };
let _loggedBlock = false;

function _statePath(env = process.env) {
  return env.BD_BREAKER_STATE_PATH || DEFAULT_STATE_PATH;
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
    value = {}; // absent/corrupt state = not tripped (fail-open, same as unknown billing)
  }
  _stateCache = { at: now, value };
  return value;
}

/**
 * THE enforcement helper. Called from exactly two chokepoints —
 * scraper.js fetchWithBrightData() and url-discovery.js _serpViaBrightData() —
 * because those are the only two places a BD request is actually issued.
 *
 * Enforcing at the outer fetchPage()/fetchJSON() gates instead was explicitly
 * rejected in review: that is the same placement that left BD SERP spend 99%
 * unattributed, since plenty of call paths reach the provider without passing
 * through those wrappers.
 *
 * Counts on ALLOW (not on success), mirroring fetchWithScrapingdog's per-attempt
 * accounting: BD bills the attempt, so the budget must reflect attempts.
 *
 * `firstBlock` is true only on the first blocked call of the process. Call
 * sites gate their telemetry row on it: a capped bulk backfill can attempt
 * thousands of fetches, and one ledger row each would evict genuine spend rows
 * from the rotating scraper-spend-ledger.jsonl — degrading the very attribution
 * metric this card is trying to raise. One row says everything the ledger needs
 * to say; the running totals live in getBrightDataRunStats().
 *
 * @param {{zone: string, env?: object, now?: Date}} params
 * @returns {{allowed: boolean, exempt: boolean, reason?: string, firstBlock?: boolean}}
 */
function consultBrightData({ zone, env = process.env, now = new Date() }) {
  if (env.BD_CAPS_DISABLED === '1') {
    return { allowed: true, exempt: true, reason: 'caps-disabled' };
  }

  const scriptName = (() => {
    try { return process.argv[1] ? path.basename(process.argv[1]) : null; } catch { return null; }
  })();
  const exempt = isExemptCaller(scriptName, resolveExemptScripts(env), env.GITHUB_WORKFLOW || null);

  if (!exempt) {
    const state = readBreakerState(env, Date.now());
    if (isBreakerActiveForZone(state, { zone, day: utcDay(now) })) {
      const entry = state.zones[zone];
      _runStats.blocked++;
      _runStats.blockedByBreaker++;
      const firstBlock = !_loggedBlock;
      if (firstBlock) {
        console.log(`  ⚠️  Bright Data daily breaker tripped for zone ${zone} (${entry.billedReqs} billed vs ceiling ${entry.ceiling}) — skipping BD for non-opening-night calls`);
        _loggedBlock = true;
      }
      return { allowed: false, exempt, reason: 'breaker', firstBlock };
    }
  }

  const budget = exempt ? resolveExemptPerRunBudget(env) : resolvePerRunBudget(env);
  const used = exempt ? _runStats.exemptUsed : _runStats.bulkUsed;
  const verdict = checkPerRunBudget({ used, budget });
  if (!verdict.allowed) {
    _runStats.blocked++;
    _runStats.blockedByBudget++;
    const firstBlock = !_loggedBlock;
    if (firstBlock) {
      console.log(`  ⚠️  ${verdict.reason} — skipping BD for remaining requests`);
      _loggedBlock = true;
    }
    return { allowed: false, exempt, reason: 'budget', firstBlock };
  }

  if (exempt) _runStats.exemptUsed++;
  else _runStats.bulkUsed++;
  return { allowed: true, exempt };
}

/**
 * Per-run counters. `blocked` is what collect-review-texts.js samples around a
 * fetch to decide whether a failure was budget_capped rather than a real dead
 * URL — a capped attempt must never count toward permanent retirement.
 */
function getBrightDataRunStats() {
  return { ..._runStats };
}

/** Test-only: reset module state between cases. */
function _resetForTests() {
  _runStats.bulkUsed = 0;
  _runStats.exemptUsed = 0;
  _runStats.blocked = 0;
  _runStats.blockedByBreaker = 0;
  _runStats.blockedByBudget = 0;
  _stateCache = { at: 0, value: null };
  _loggedBlock = false;
}

module.exports = {
  DEFAULT_DAILY_REQ_CEILING,
  DEFAULT_EXEMPT_SCRIPTS,
  resolveDailyCeiling,
  resolvePerRunBudget,
  resolveExemptPerRunBudget,
  resolveExemptScripts,
  shouldTripBreaker,
  isExemptCaller,
  checkPerRunBudget,
  isBreakerActiveForZone,
  breakerAlertSeverity,
  utcDay,
  readBreakerState,
  consultBrightData,
  getBrightDataRunStats,
  _resetForTests,
};
