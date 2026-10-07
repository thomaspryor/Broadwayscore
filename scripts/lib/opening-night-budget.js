/**
 * Opening-night resource budget pre-flight.
 *
 * estimateBudget(numShows) is pure: per-resource perShow + total + threshold.
 * checkBudget(numShows, opts) is async: fetches live remaining (where the API
 * supports it) and returns { ok, blockers, warnings, estimate, usage }.
 *
 * Per-show estimates are best-guess defaults derived from the last ~10 opening
 * nights. Recalibrate via memory/opening-night-budget-tuning.md.
 *
 * Resources:
 *   scrapingbee   credits   live remaining via SB usage API
 *   brightdata    requests  live spent-today via BD zone/cost billing API
 *   browserbase   sessions  cap-based (no public per-day usage endpoint)
 *   anthropic     dollars   cap-based (no live spend API)
 *   openai        dollars   cap-based (no live spend API)
 *   gemini        dollars   cap-based (no live spend API)
 *   gha_minutes   minutes   live remaining via GH billing API (private repos only)
 */

'use strict';

const https = require('https');
const path = require('path');
const { countShowsInOpeningWindow } = require('./opening-night-selection');

const DEFAULT_SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');

// Task #1315, card-specified window: [today-1, today+3]. NOT the same
// question as countShowsInOpeningWindow's own default (lookbackDays 3, used
// for breaker ALERT SEVERITY — "is a poller hammering this provider
// tonight"). This window answers "does BD need a reservation for this show
// right now" — mostly forward-looking (protects the 3 days BEFORE a show
// opens, so day-of budget is never starved by the time it does) plus ONE
// trailing day, which is what actually caught the incident this task fixes:
// Death Note opened 2026-08-11, and check-opening-night-readiness.js ran (and
// its 4 missed reviews published) the next day, 2026-08-12 — exactly
// today-1. It is deliberately narrower than the 3-day trailing lookback used
// for severity: reviews arriving 2-3+ days after opening are a distinct,
// slower-moving coverage-gap problem (T1/T2 stuck-review alerts), not the
// acute same-day-starvation this reservation targets.
const RESERVE_WINDOW_OPTS = { lookbackDays: 1, lookAheadHours: 72 };

/** Shows currently within the reservation window, reading live shows.json. */
function countOpeningWindowShows(showsPath = DEFAULT_SHOWS_PATH, now = new Date()) {
  return countShowsInOpeningWindow(showsPath, { ...RESERVE_WINDOW_OPTS, now });
}

// Per-show resource consumption defaults. See memory/opening-night-budget-tuning.md.
const DEFAULT_PER_SHOW = Object.freeze({
  scrapingbee: 50000,
  // Bright Data requests per show (Scraping cost v3 S2-T7). ~250 is the
  // observed poller cost of one opening night: the 2026-08-02 ledger attributed
  // 554 unlocker calls to a half-day covering two shows, plus SERP. This is the
  // opening-night pool ONLY — bulk flows have their own per-run budget and are
  // subject to the daily circuit breaker, from which opening night is exempt
  // (see scripts/lib/brightdata-caps.js). A shared pool was explicitly rejected
  // in plan review: bulk traffic must never be able to drain what the poller
  // needs on the one night it matters.
  brightdata: 250,
  browserbase: 5,
  anthropic: 0.40,
  openai: 0.30,
  gemini: 0.05,
  gha_minutes: 60,
});

// Resource caps. Hard limits the platform enforces; we treat these as the
// upper bound when no live remaining is available.
const DEFAULT_CAPS = Object.freeze({
  scrapingbee: { totalCap: 5350000, softFloorPct: 0.5 }, // soft floor used as informational threshold
  // Opening night's own daily Bright Data allowance, independent of the bulk
  // ceiling in brightdata-caps.js (3,500/zone). 3,000 covers ~12 shows on the
  // busiest observed night with room to spare; exceeding it means something is
  // looping, not that a night is unusually large.
  brightdata: { dailyCap: 3000 },
  browserbase: { dailyCap: 30, hardCap: 200 },
  anthropic: { dailyDollarCap: 100 }, // raised 50→100 (owner 2026-07-22: $60/night autonomous loop must pass checkSharedDailyCap; sustained spend bounded by the loop's weeklyUSD, not this)
  openai: { dailyDollarCap: 30 },
  gemini: { dailyDollarCap: 10 },
  gha_minutes: { monthlyCap: 2000 },
});

/**
 * Pure. Returns the estimated consumption + threshold for each resource.
 *
 * @param {number} numShows
 * @param {object} [perShow] — override per-show defaults
 * @param {object} [caps] — override platform caps
 */
function estimateBudget(numShows, perShow = DEFAULT_PER_SHOW, caps = DEFAULT_CAPS) {
  if (!Number.isFinite(numShows) || numShows < 0) {
    throw new TypeError(`numShows must be a non-negative number (got ${numShows})`);
  }
  return {
    scrapingbee: {
      perShow: perShow.scrapingbee,
      total: numShows * perShow.scrapingbee,
      threshold: Math.round(caps.scrapingbee.softFloorPct * caps.scrapingbee.totalCap),
    },
    brightdata: {
      perShow: perShow.brightdata,
      total: numShows * perShow.brightdata,
      threshold: caps.brightdata.dailyCap,
    },
    browserbase: {
      perShow: perShow.browserbase,
      total: numShows * perShow.browserbase,
      threshold: caps.browserbase.dailyCap,
    },
    anthropic: {
      perShow: perShow.anthropic,
      total: round2(numShows * perShow.anthropic),
      threshold: caps.anthropic.dailyDollarCap,
    },
    openai: {
      perShow: perShow.openai,
      total: round2(numShows * perShow.openai),
      threshold: caps.openai.dailyDollarCap,
    },
    gemini: {
      perShow: perShow.gemini,
      total: round2(numShows * perShow.gemini),
      threshold: caps.gemini.dailyDollarCap,
    },
    gha_minutes: {
      perShow: perShow.gha_minutes,
      total: numShows * perShow.gha_minutes,
      threshold: caps.gha_minutes.monthlyCap,
    },
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

// ── Live usage fetchers ─────────────────────────────────────────────────────

function httpsGetJson(url, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        timeout: timeoutMs,
      }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, data: null }); }
        });
      });
      req.on('error', () => resolve({ status: 0, data: null }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null }); });
      req.end();
    } catch {
      resolve({ status: 0, data: null });
    }
  });
}

async function fetchScrapingBeeRemaining() {
  const key = process.env.SCRAPINGBEE_API_KEY;
  if (!key) return { remaining: null, reason: 'no-key' };
  const { fetchSBCreditStatus } = require('./check-sb-credits');
  const status = await fetchSBCreditStatus();
  if (!status.ok) return { remaining: null, reason: status.reason || 'api-error' };
  return {
    remaining: status.remaining,
    used: status.usedCredits,
    max: status.maxCredits,
    pctUsed: status.pctUsed,
  };
}

/**
 * Bright Data requests still available to opening night today (S2-T7).
 *
 * "Spent" comes from BD's own zone/cost billing API, summed across both zones —
 * the same ground truth the circuit breaker uses, and for the same reason: our
 * ledger under-attributes BD badly enough that a ledger-derived number would
 * report a comfortable margin on a day we had already blown through it.
 *
 * Note this counts ALL BD spend today, not just opening night's. That is
 * deliberate for a PRE-FLIGHT: the question it answers is "can tonight's shift
 * actually get its requests through", and a bulk backfill that already spent
 * the day's budget is exactly the situation the owner needs flagged before the
 * shift starts — but see `applyOpeningWindowReserve` below (task #1315): a
 * show in its own opening window still gets its reservation floor reported as
 * available even when routine/bulk spend has driven the raw total past the
 * cap, matching the real exemption brightdata-caps.js already enforces at the
 * request chokepoint.
 *
 * @param {object} [caps]
 * @param {object} [opts]
 * @param {number} [opts.openingWindowReserve] - requests guaranteed regardless
 *   of aggregate daily spend (see applyOpeningWindowReserve)
 */
async function fetchBrightDataRemaining(caps = DEFAULT_CAPS, opts = {}) {
  const token = process.env.BRIGHTDATA_TOKEN;
  if (!token) return { remaining: null, reason: 'no-token' };
  const { fetchBdZoneCostDay } = require('./provider-billing');
  const day = new Date().toISOString().slice(0, 10);
  const zones = [
    process.env.BRIGHTDATA_ZONE || 'web_unlocker2',
    process.env.BRIGHTDATA_SERP_ZONE || 'serp_api1',
  ];
  const results = await Promise.all(zones.map((z) => fetchBdZoneCostDay(z, day, token).catch(() => null)));
  // Any unreadable zone makes the total unknown — a partial sum would understate
  // spend and read as "plenty left" (provider-billing.js's fail-closed rule).
  if (results.some((r) => r == null)) return { remaining: null, reason: 'api-error' };
  const used = results.reduce((sum, r) => sum + r.reqs, 0);
  const max = caps.brightdata.dailyCap;
  const reserve = opts.openingWindowReserve || 0;
  const remaining = applyOpeningWindowReserve({ used, max, reserve });
  return { remaining, used, max, reserve };
}

/**
 * Pure reservation math (task #1315), extracted so it's testable without a
 * BRIGHTDATA_TOKEN/network round-trip: `fetchBrightDataRemaining` returns
 * early with remaining:null when no token is set, which would otherwise make
 * the reservation floor untestable outside a live-credentialed environment.
 *
 * `reserve` is a floor, not an addition: it guarantees an opening-window show
 * is never reported as having less than its reservation, regardless of how
 * much routine/bulk traffic has consumed of the raw daily cap — mirroring the
 * real exemption at the request chokepoint (brightdata-caps.js
 * consultBrightData never checks the breaker for exempt callers at all).
 *
 * @param {{used: number, max: number, reserve: number}} params
 * @returns {number}
 */
function applyOpeningWindowReserve({ used, max, reserve }) {
  const base = Math.max(0, max - used);
  const r = Number.isFinite(reserve) && reserve > 0 ? reserve : 0;
  return r > 0 ? Math.max(r, base) : base;
}

async function fetchGhaMinutesRemaining() {
  // The /users/{owner}/settings/billing/actions endpoint requires a PAT with
  // the `user` scope. The auto-issued GITHUB_TOKEN does NOT have that scope,
  // so any call from CI returns 403 and silently degrades to cap-based
  // comparison. Rather than misleadingly advertising a "live" GHA check that
  // never works, return null with an explicit reason. To enable live remaining,
  // set GHA_BILLING_PAT in the environment with read:user + billing scope.
  const pat = process.env.GHA_BILLING_PAT;
  if (!pat) return { remaining: null, reason: 'requires-pat-with-user-scope' };
  const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
  const owner = repo.split('/')[0];
  const { status, data } = await httpsGetJson(
    `https://api.github.com/users/${owner}/settings/billing/actions`,
    {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'broadwayscorecard-budget',
    },
  );
  if (status !== 200 || !data) return { remaining: null, reason: `status-${status}` };
  const total = Number(data.total_minutes_used) || 0;
  const included = Number(data.included_minutes) || 2000;
  return {
    remaining: Math.max(0, included - total),
    used: total,
    max: included,
  };
}

/**
 * Fetch live availability for resources we can query. Resources without a
 * live API return remaining: null and the cap is used as the comparison.
 *
 * @param {object} [opts]
 * @param {number} [opts.openingWindowReserve] - explicit BD reserve (requests).
 *   Takes priority when present (tests). Otherwise `opts.openingWindowShows *
 *   perShow.brightdata` if `openingWindowShows` is given, else auto-detected
 *   from live shows.json — so EVERY real caller (this function called bare,
 *   or checkBudget() calling it without an injected liveUsage) gets the
 *   reservation without having to know it exists (task #1315).
 * @param {number} [opts.openingWindowShows] - override the auto-detected count
 * @param {object} [opts.perShow] - per-show estimate defaults (for the reserve calc)
 */
async function fetchLiveUsage(opts = {}) {
  const perShow = opts.perShow || DEFAULT_PER_SHOW;
  const reserve = Object.prototype.hasOwnProperty.call(opts, 'openingWindowReserve')
    ? opts.openingWindowReserve
    : (Object.prototype.hasOwnProperty.call(opts, 'openingWindowShows')
      ? opts.openingWindowShows
      : countOpeningWindowShows()) * (perShow.brightdata || DEFAULT_PER_SHOW.brightdata);
  const [sb, bd, gha] = await Promise.all([
    fetchScrapingBeeRemaining().catch(() => ({ remaining: null, reason: 'threw' })),
    fetchBrightDataRemaining(DEFAULT_CAPS, { openingWindowReserve: reserve }).catch(() => ({ remaining: null, reason: 'threw' })),
    fetchGhaMinutesRemaining().catch(() => ({ remaining: null, reason: 'threw' })),
  ]);
  return {
    scrapingbee: sb,
    brightdata: bd,
    browserbase: { remaining: null, reason: 'no-api' },
    anthropic: { remaining: null, reason: 'no-api' },
    openai: { remaining: null, reason: 'no-api' },
    gemini: { remaining: null, reason: 'no-api' },
    gha_minutes: gha,
  };
}

// ── Budget check ────────────────────────────────────────────────────────────

/**
 * Compare estimated consumption against live (or cap-based) availability.
 *
 * Hard blocker: needed > available (fails the pre-flight).
 * Soft warning: needed > 0.9 * available (tight squeeze) — or, when no live
 * API is available, needed > threshold (informational).
 *
 * @param {number} numShows
 * @param {object} [opts]
 * @param {object} [opts.liveUsage] — inject for tests; if absent, fetched live
 * @param {object} [opts.perShow]
 * @param {object} [opts.caps]
 * @param {number} [opts.openingWindowShows] - override the opening-window show
 *   count used for the BD reservation (tests); auto-detected otherwise
 * @param {number} [opts.openingWindowReserve] - override the BD reservation
 *   directly (requests), taking priority over openingWindowShows (tests)
 */
async function checkBudget(numShows, opts = {}) {
  const { liveUsage, perShow = DEFAULT_PER_SHOW, caps = DEFAULT_CAPS } = opts;
  const usage = liveUsage || await fetchLiveUsage(opts);
  const estimate = estimateBudget(numShows, perShow, caps);

  const blockers = [];
  const warnings = [];

  function evaluate(resource, unit, format = (v) => String(v)) {
    const need = estimate[resource].total;
    const live = usage[resource]?.remaining ?? null;
    const threshold = estimate[resource].threshold;

    if (live != null) {
      if (need > live) {
        blockers.push({
          resource,
          needed: need,
          available: live,
          unit,
          message: `${resource}: need ${format(need)} ${unit}, only ${format(live)} ${unit} remaining`,
        });
      } else if (need > live * 0.9) {
        warnings.push({
          resource,
          needed: need,
          available: live,
          unit,
          message: `${resource}: need ${format(need)} of ${format(live)} ${unit} remaining (>90%) — tight squeeze`,
        });
      }
      return;
    }

    // No live data — fall back to threshold (cap) comparison.
    if (need > threshold) {
      blockers.push({
        resource,
        needed: need,
        available: threshold,
        unit,
        message: `${resource}: need ${format(need)} ${unit}, exceeds platform cap of ${format(threshold)} ${unit} (no live API; cap-based)`,
      });
    } else if (need > threshold * 0.75) {
      warnings.push({
        resource,
        needed: need,
        available: threshold,
        unit,
        message: `${resource}: need ${format(need)} ${unit} — ${Math.round((need / threshold) * 100)}% of ${format(threshold)} ${unit} cap`,
      });
    }
  }

  const dollars = (n) => `$${n.toFixed(2)}`;
  evaluate('scrapingbee', 'credits');
  evaluate('brightdata', 'requests');
  evaluate('browserbase', 'sessions');
  evaluate('anthropic', '', dollars);
  evaluate('openai', '', dollars);
  evaluate('gemini', '', dollars);
  evaluate('gha_minutes', 'minutes');

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    estimate,
    usage,
    numShows,
  };
}

module.exports = {
  estimateBudget,
  checkBudget,
  fetchLiveUsage,
  fetchScrapingBeeRemaining,
  fetchBrightDataRemaining,
  fetchGhaMinutesRemaining,
  applyOpeningWindowReserve,
  countOpeningWindowShows,
  RESERVE_WINDOW_OPTS,
  DEFAULT_PER_SHOW,
  DEFAULT_CAPS,
};

// ── CLI: node scripts/lib/opening-night-budget.js [N] ───────────────────────

if (require.main === module) {
  (async () => {
    const numShows = Number(process.argv[2]) || 1;
    const result = await checkBudget(numShows);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  })().catch((err) => {
    console.error('budget check failed:', err.message);
    process.exit(2);
  });
}
