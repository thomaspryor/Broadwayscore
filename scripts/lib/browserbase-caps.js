/**
 * Pure cap-decision function for Browserbase session usage.
 *
 * Extracted from scripts/collect-review-texts.js so the cap logic can be
 * unit-tested with concrete inputs instead of mocking the entire collector.
 * Production code requires this module — change the function, test fails.
 *
 * DEFAULT_EXEMPT_SCRIPTS is required from brightdata-caps.js at module
 * top-level (not lazily inside resolveExemptScripts) — matches
 * scrapingdog-caps.js's own top-level `const { ... } = require('./brightdata-caps')`.
 *
 * The caps exist to prevent runaway Browserbase spend. February 2026 saw
 * 12,876 sessions in one week ($1,287) before any caps existed. April 2026
 * (the peak opening-night month) had max 275 sessions/day. The default
 * MAX_PER_DAY of 250 is set just above that empirical peak so legitimate
 * opening-night activity is preserved while runaway scripts get clipped at
 * $25/day = $750/mo max.
 */
'use strict';

const { DEFAULT_EXEMPT_SCRIPTS: BD_DEFAULT_EXEMPT_SCRIPTS } = require('./brightdata-caps');

/**
 * THE daily-ceiling default. Both enforcement points — collect-review-texts.js
 * (local usage file) and lib/bww-rr-discover.js (live API count) — must resolve
 * the same number, because they cap the SAME Browserbase account.
 *
 * They used to each hard-code `250`, with bww-rr-discover.js only *asserting*
 * the invariant in a comment ("Enforce the SAME account-wide daily ceiling
 * collect-review-texts.js uses"). A comment is not a mechanism: the Scraping v2
 * T13 step-down (250 -> 100 -> 60) edits this ceiling, and editing one literal
 * would have silently left the other path at 250 — the cap would read as
 * lowered while half the spend stayed uncapped. One constant, one edit site.
 *
 * Sizing rationale: April 2026 (peak opening-night month) topped out at 275
 * sessions/day; 250 sits just under that empirical peak, bounding worst case at
 * $25/day = $750/mo. Stepping it down is deliberately EVIDENCE-GATED — see
 * memory/browserbase-cap-stepdown-runbook.md. Do not lower this number without
 * running that runbook's gate check first.
 */
const DEFAULT_MAX_SESSIONS_PER_DAY = 250;

/**
 * Resolve the daily ceiling: BROWSERBASE_MAX_SESSIONS_PER_DAY when set to a
 * positive integer, else the shared default. Garbage/negative/zero env values
 * fall back rather than silently disabling (parseInt('') === NaN) or pinning
 * the cap at 0 (which would block every session).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function resolveMaxSessionsPerDay(env = process.env) {
  const raw = parseInt(env.BROWSERBASE_MAX_SESSIONS_PER_DAY, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_SESSIONS_PER_DAY;
}

/**
 * Per-show reservation carved OUT of the daily ceiling for bulk (non-exempt)
 * callers whenever a show is in its opening window (#1333, the Browserbase
 * half of #1315/#1330's fix — the identical flat-ceiling starvation gap:
 * createBbSession's account-wide day cap had no opening-window carve-out, so
 * a routine bulk sweep could exhaust the day's sessions a show needs for its
 * opening-night BWW reviews.php / paywall-login flow).
 *
 * Reuses opening-night-budget.js's own DEFAULT_PER_SHOW.browserbase estimate
 * (5 sessions/show) rather than inventing a new sizing scheme, per the card's
 * suggested approach — kept as an independent literal rather than a shared
 * import for the same reason brightdata-caps.js documents for its own
 * DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW: this file is the low-level
 * per-session chokepoint dependency and must not pull in
 * opening-night-budget.js's higher-level estimator just to read one number.
 */
const DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW = 5;

/**
 * Opening-window per-show reserve: BROWSERBASE_OPENING_WINDOW_RESERVE_PER_SHOW,
 * else the default. Same garbage/negative/zero fallback rule as
 * resolveMaxSessionsPerDay.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function resolveOpeningWindowReservePerShow(env = process.env) {
  const raw = parseInt(env.BROWSERBASE_OPENING_WINDOW_RESERVE_PER_SHOW, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW;
}

/**
 * Exempt-script allowlist: BROWSERBASE_EXEMPT_SCRIPTS (comma-separated)
 * overrides, else brightdata-caps.js's own list (imported, not copied — same
 * scripts do opening-night discovery across all three providers; mirrors
 * scrapingdog-caps.js's resolveExemptScripts).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function resolveExemptScripts(env = process.env) {
  const raw = (env.BROWSERBASE_EXEMPT_SCRIPTS || '').trim();
  if (!raw) return BD_DEFAULT_EXEMPT_SCRIPTS.slice();
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Recovery reserve carved out of the daily ceiling (BRO-5222). On 2026-10-12
 * routine sweeps used all 250 sessions by mid-morning, so 61 WSJ rows (a
 * Browserbase-only outlet) never reached Browserbase and were reported as
 * unrecoverable. Runs that do not opt in stop at maxPerDay - reserve; runs
 * started with BROWSERBASE_USE_RESERVE=true (targeted recovery, opening night)
 * may use the full ceiling. The ceiling itself is unchanged.
 */
const DEFAULT_RECOVERY_RESERVE = 30;

/**
 * BROWSERBASE_RECOVERY_RESERVE when a non-negative integer, else the default.
 * 0 is allowed (turns the reserve off).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function resolveRecoveryReserve(env = process.env) {
  const raw = parseInt(env.BROWSERBASE_RECOVERY_RESERVE, 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RECOVERY_RESERVE;
}

/**
 * Does this run consume the recovery reserve? Explicit opt-in only.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function resolveUseReserve(env = process.env) {
  return String(env.BROWSERBASE_USE_RESERVE || '').trim().toLowerCase() === 'true';
}

// BRO-5243: the opening-window reserve is 5 sessions per show in the window,
// but on 2026-10-13 that window held 23 shows (mostly off-West-End and
// off-Broadway cold opens) and reserved 115 of 250 sessions, while exempt
// opening-night callers never used more than 74 in a day (Sept 29 to Oct 12).
// The unused slice starved WSJ recovery. Cap the reserve near the observed
// exempt peak; the per-show rate still applies below the cap.
const DEFAULT_OPENING_WINDOW_RESERVE_MAX = 75;

function resolveOpeningWindowReserveMax(env = process.env) {
  const raw = parseInt(env.BROWSERBASE_OPENING_WINDOW_RESERVE_MAX, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OPENING_WINDOW_RESERVE_MAX;
}

/** Window the opening-window reserve counts shows in: opened yesterday to two days ahead. */
const OPENING_WINDOW_RESERVE_OPTS = Object.freeze({ lookbackDays: 1, lookAheadHours: 48 });

/**
 * Sessions held back for opening-window shows: reservePerShow per show,
 * never more than reserveMax.
 */
function openingWindowReserve({ openingWindowShows, reservePerShow, reserveMax }) {
  if (!Number.isFinite(openingWindowShows) || openingWindowShows <= 0) return 0;
  if (!Number.isFinite(reservePerShow) || reservePerShow <= 0) return 0;
  const reserve = openingWindowShows * reservePerShow;
  return Number.isFinite(reserveMax) && reserveMax > 0 ? Math.min(reserve, reserveMax) : reserve;
}

// BRO-5243: Tier-1 paywalled outlets with no other CI route. These hosts may
// spend the recovery reserve that every other bulk host must leave alone, so a
// day of blog and trade-site fetches can no longer lock WSJ out.
const TIER1_RECOVERY_HOSTS = Object.freeze(['wsj.com', 'nytimes.com', 'newyorker.com']);

// BRO-5243: hosts that are never reviews (ticket sellers, event listings,
// social, consumer ratings). ~280 Browserbase sessions went to these in the
// two weeks to 2026-10-12. Browserbase is never spent on them.
const DEFAULT_DENY_HOSTS = Object.freeze([
  'trustpilot.com',
  'facebook.com',
  'oklahomatickets.com',
  'londontheatredirect.com',
  'ticketline.co.uk',
  'donyc.com',
  'events.newyorkfamily.com',
  'talkclassical.com',
]);

/** Defaults plus any extra hosts in BROWSERBASE_DENY_HOSTS (comma-separated). */
function resolveDenyHosts(env = process.env) {
  const extra = String(env.BROWSERBASE_DENY_HOSTS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...DEFAULT_DENY_HOSTS, ...extra])];
}

/** host equals a listed domain or is a subdomain of one; null-safe, ignores a leading www. */
function hostMatchesAny(host, domains) {
  if (!host || typeof host !== 'string') return false;
  const h = host.trim().toLowerCase().replace(/^www\./, '');
  if (!h) return false;
  return (domains || []).some((d) => h === d || h.endsWith(`.${d}`));
}

function isDeniedHost(host, env = process.env) {
  return hostMatchesAny(host, resolveDenyHosts(env));
}

function isTier1RecoveryHost(host) {
  return hostMatchesAny(host, TIER1_RECOVERY_HOSTS);
}

/**
 * BRO-5243 Option B (owner decision, Linear BRO-5243 comment 2026-10-13T13:15Z):
 * a time-boxed raise of the daily ceiling for Tier-1 recovery hosts only, so
 * the WSJ/NYT/New Yorker backlog can drain. It switches itself off at `until`
 * (through 2026-10-27 UTC); nothing needs reverting. Kill switch:
 * BROWSERBASE_TIER1_BOOST_DISABLED=true. Delete this block, its two call sites
 * (browserbase-session.js, collect-review-texts.js) and its tests after expiry.
 */
const TIER1_RECOVERY_BOOST = Object.freeze({ sessions: 100, until: '2026-10-28T00:00:00Z' });

/** Extra sessions the boost adds today, for any host (0 once expired or disabled). */
function activeTier1Boost({ now = new Date(), env = process.env } = {}) {
  if (env.BROWSERBASE_TIER1_BOOST_DISABLED === 'true') return 0;
  return now.getTime() < Date.parse(TIER1_RECOVERY_BOOST.until) ? TIER1_RECOVERY_BOOST.sessions : 0;
}

/** Extra sessions the boost adds for this host: activeTier1Boost on Tier-1 hosts, else 0. */
function tier1RecoveryBoost(host, opts = {}) {
  return isTier1RecoveryHost(host) ? activeTier1Boost(opts) : 0;
}

/**
 * The boost a caller's day ceiling gets: exempt (opening-night) callers get it
 * for any host, so boosted Tier-1 spend never squeezes them; others only on
 * Tier-1 hosts. The chokepoint and the collector's local check both use this.
 */
function tier1BoostForCaller(host, { exempt = false, ...opts } = {}) {
  return exempt ? activeTier1Boost(opts) : tier1RecoveryBoost(host, opts);
}

/**
 * Owner-approved (2026-10-19) daily session allowance for named callers that
 * have no other route: Talkin' Broadway sits behind a Cloudflare challenge, so
 * its pages are only readable through Browserbase. A caller listed here may
 * ignore the opening-window and recovery reserves, but never the raw daily
 * ceiling (maxPerDay + the Tier-1 boost), and never more than `sessionsPerDay`
 * sessions of its own in the trailing 24h (counted from the live sessions list
 * by userMetadata.caller; see browserbase-live-usage.js). Each entry expires at
 * `until`; extend it with evidence, or delete it. A second lane is one new line.
 * Kill switch: BROWSERBASE_CALLER_ALLOWANCES_DISABLED=true.
 */
const CALLER_ALLOWANCES = Object.freeze({
  'probe-talkinbroadway-browserbase.js': Object.freeze({ sessionsPerDay: 3, until: '2026-11-19T00:00:00Z' }),
  'collect-talkinbroadway-index.js': Object.freeze({ sessionsPerDay: 8, until: '2026-11-19T00:00:00Z' }),
  // The opening-night lane reads TB through one session at a time, rotated hourly: a 5 h night is ~6 (BRO-6073).
  'opening-night-lane': Object.freeze({ sessionsPerDay: 8, until: '2026-11-19T00:00:00Z' }),
});

/** Sessions/day this caller may spend from its allowance (0 if unlisted, expired or disabled). */
function callerAllowance(caller, { now = new Date(), env = process.env } = {}) {
  if (env.BROWSERBASE_CALLER_ALLOWANCES_DISABLED === 'true') return 0;
  const entry = Object.prototype.hasOwnProperty.call(CALLER_ALLOWANCES, caller) ? CALLER_ALLOWANCES[caller] : null;
  if (!entry) return 0;
  return now.getTime() < Date.parse(entry.until) ? entry.sessionsPerDay : 0;
}

/**
 * @param {object} params
 * @param {number} params.sessionsToday - Sessions consumed across all runs today
 * @param {number} params.sessionsThisRun - Sessions consumed in the current run
 * @param {object} params.sessionsPerDomain - Map of {domain: count} for today
 * @param {string} [params.urlDomain] - Hostname of the URL being fetched
 * @param {object} params.config - Caps: maxPerDay, maxPerRun, maxPerDomain,
 *   optional reserve (sessions held back from runs without useReserve) and useReserve
 * @returns {{allowed: boolean, reason?: 'day'|'run'|'domain', limit?: number, used?: number}}
 */
/**
 * Count one Browserbase attempt against a caller's local usage counters, or
 * (delta -1) give it back when the session-create chokepoint refused before
 * any session existed (err.bbNoSession, browserbase-session.js). Without the
 * refund a run of refusals used up the per-run and per-domain caps and shut
 * out the Tier-1 rows behind them (BRO-5261).
 */
function countBrowserbaseAttempt(usage, urlDomain, delta = 1) {
  const step = (n) => Math.max(0, (n || 0) + delta);
  usage.sessionsToday = step(usage.sessionsToday);
  usage.sessionsThisRun = step(usage.sessionsThisRun);
  if (urlDomain) {
    usage.sessionsPerDomain = usage.sessionsPerDomain || {};
    usage.sessionsPerDomain[urlDomain] = step(usage.sessionsPerDomain[urlDomain]);
  }
  return usage;
}

function checkBrowserbaseCaps({
  sessionsToday,
  sessionsThisRun,
  sessionsPerDomain,
  urlDomain,
  config,
}) {
  const { maxPerDay, maxPerRun, maxPerDomain } = config;
  const reserve = config.useReserve ? 0 : Math.max(0, config.reserve || 0);
  const dayLimit = Math.max(0, maxPerDay - reserve);

  if (sessionsToday >= dayLimit) {
    return { allowed: false, reason: 'day', limit: dayLimit, used: sessionsToday };
  }
  if (sessionsThisRun >= maxPerRun) {
    return { allowed: false, reason: 'run', limit: maxPerRun, used: sessionsThisRun };
  }
  if (urlDomain) {
    const domainUsed = sessionsPerDomain[urlDomain] || 0;
    if (domainUsed >= maxPerDomain) {
      return { allowed: false, reason: 'domain', limit: maxPerDomain, used: domainUsed };
    }
  }
  return { allowed: true };
}

module.exports = {
  checkBrowserbaseCaps,
  countBrowserbaseAttempt,
  resolveMaxSessionsPerDay,
  resolveOpeningWindowReservePerShow,
  resolveExemptScripts,
  resolveRecoveryReserve,
  resolveUseReserve,
  DEFAULT_RECOVERY_RESERVE,
  DEFAULT_MAX_SESSIONS_PER_DAY,
  DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW,
  DEFAULT_OPENING_WINDOW_RESERVE_MAX,
  resolveOpeningWindowReserveMax,
  OPENING_WINDOW_RESERVE_OPTS,
  openingWindowReserve,
  TIER1_RECOVERY_HOSTS,
  TIER1_RECOVERY_BOOST,
  activeTier1Boost,
  tier1RecoveryBoost,
  tier1BoostForCaller,
  CALLER_ALLOWANCES,
  callerAllowance,
  DEFAULT_DENY_HOSTS,
  resolveDenyHosts,
  hostMatchesAny,
  isDeniedHost,
  isTier1RecoveryHost,
};
