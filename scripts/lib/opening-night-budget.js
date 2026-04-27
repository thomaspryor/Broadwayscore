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
 *   browserbase   sessions  cap-based (no public per-day usage endpoint)
 *   anthropic     dollars   cap-based (no live spend API)
 *   openai        dollars   cap-based (no live spend API)
 *   gemini        dollars   cap-based (no live spend API)
 *   gha_minutes   minutes   live remaining via GH billing API (private repos only)
 */

'use strict';

const https = require('https');

// Per-show resource consumption defaults. See memory/opening-night-budget-tuning.md.
const DEFAULT_PER_SHOW = Object.freeze({
  scrapingbee: 50000,
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
  browserbase: { dailyCap: 30, hardCap: 200 },
  anthropic: { dailyDollarCap: 50 },
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
 */
async function fetchLiveUsage() {
  const [sb, gha] = await Promise.all([
    fetchScrapingBeeRemaining().catch(() => ({ remaining: null, reason: 'threw' })),
    fetchGhaMinutesRemaining().catch(() => ({ remaining: null, reason: 'threw' })),
  ]);
  return {
    scrapingbee: sb,
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
 */
async function checkBudget(numShows, opts = {}) {
  const { liveUsage, perShow = DEFAULT_PER_SHOW, caps = DEFAULT_CAPS } = opts;
  const usage = liveUsage || await fetchLiveUsage();
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
  fetchGhaMinutesRemaining,
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
