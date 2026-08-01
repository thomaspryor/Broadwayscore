/**
 * Pure cap-decision function for Browserbase session usage.
 *
 * Extracted from scripts/collect-review-texts.js so the cap logic can be
 * unit-tested with concrete inputs instead of mocking the entire collector.
 * Production code requires this module — change the function, test fails.
 *
 * The caps exist to prevent runaway Browserbase spend. February 2026 saw
 * 12,876 sessions in one week ($1,287) before any caps existed. April 2026
 * (the peak opening-night month) had max 275 sessions/day. The default
 * MAX_PER_DAY of 250 is set just above that empirical peak so legitimate
 * opening-night activity is preserved while runaway scripts get clipped at
 * $25/day = $750/mo max.
 */

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
 * @param {object} params
 * @param {number} params.sessionsToday - Sessions consumed across all runs today
 * @param {number} params.sessionsThisRun - Sessions consumed in the current run
 * @param {object} params.sessionsPerDomain - Map of {domain: count} for today
 * @param {string} [params.urlDomain] - Hostname of the URL being fetched
 * @param {object} params.config - Caps: maxPerDay, maxPerRun, maxPerDomain
 * @returns {{allowed: boolean, reason?: 'day'|'run'|'domain', limit?: number, used?: number}}
 */
function checkBrowserbaseCaps({
  sessionsToday,
  sessionsThisRun,
  sessionsPerDomain,
  urlDomain,
  config,
}) {
  const { maxPerDay, maxPerRun, maxPerDomain } = config;

  if (sessionsToday >= maxPerDay) {
    return { allowed: false, reason: 'day', limit: maxPerDay, used: sessionsToday };
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
  resolveMaxSessionsPerDay,
  DEFAULT_MAX_SESSIONS_PER_DAY,
};
