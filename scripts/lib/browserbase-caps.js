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

module.exports = { checkBrowserbaseCaps };
