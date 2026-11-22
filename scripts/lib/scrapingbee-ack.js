/**
 * Expiring acknowledgment for the known ScrapingBee credit exhaustion (card
 * #224, resets 2026-08-05). Mirrors the npm audit allowlist pattern
 * (scripts/audit-dependencies.js): a known, already-tracked outage errors two
 * separate health checks (check-secrets-health.js, health-check.js's Credits
 * category) daily until the acknowledgment expires, forcing re-triage instead
 * of silently masking forever. Single source of truth so both checks can't
 * drift out of sync on the reason/expiry (ship-check finding, task #353).
 */

'use strict';

const SCRAPINGBEE_ACKNOWLEDGED_EXHAUSTION = {
  reason: 'Monthly API limit exhausted (1M credits) — tracked in card #224, resets on billing cycle.',
  expires: '2026-08-05',
};

// BRO-7568: owner rule 2026-08-03, ScrapingBee exhaustion is ridden out until the
// billing reset, never re-triaged as a billing question. The standing policy lives in
// scripts/config/provider-spend-thresholds.json rideOutPacks (also read by
// provider-spend-core.js budgetBreaches); while ScrapingBee is listed there its
// exhaustion stays acknowledged, so the dated expiry above no longer turns the two
// health checks red every day. Remove it from rideOutPacks to re-arm them.
function isScrapingBeeRideOut(thresholds) {
  let cfg = thresholds;
  if (cfg === undefined) {
    try { cfg = require('../config/provider-spend-thresholds.json'); } catch { cfg = null; }
  }
  return Array.isArray(cfg?.rideOutPacks) && cfg.rideOutPacks.includes('scrapingbee');
}

function isScrapingBeeExhaustionAcknowledged(today, thresholds) {
  if (isScrapingBeeRideOut(thresholds)) return true;
  const todayDate = today || new Date().toISOString().slice(0, 10);
  return SCRAPINGBEE_ACKNOWLEDGED_EXHAUSTION.expires > todayDate;
}

/**
 * The "[expires YYYY-MM-DD]" tag the health checks print after an acknowledged
 * exhaustion. digest-autofix.js / start-now-filing.js ACKNOWLEDGED_ROW_RE only
 * read that exact shape, so under ride-out the expiry rolls to tomorrow: renewed
 * on every health run, lapsing a day after ride-out is removed.
 */
function scrapingBeeAckTag(thresholds, today) {
  if (!isScrapingBeeRideOut(thresholds)) return `expires ${SCRAPINGBEE_ACKNOWLEDGED_EXHAUSTION.expires}`;
  const base = Date.parse(`${today || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return `expires ${new Date(base + 86400000).toISOString().slice(0, 10)}`;
}

module.exports = { SCRAPINGBEE_ACKNOWLEDGED_EXHAUSTION, isScrapingBeeExhaustionAcknowledged, isScrapingBeeRideOut, scrapingBeeAckTag };
