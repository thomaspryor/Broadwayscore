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

function isScrapingBeeExhaustionAcknowledged(today) {
  const todayDate = today || new Date().toISOString().slice(0, 10);
  return SCRAPINGBEE_ACKNOWLEDGED_EXHAUSTION.expires > todayDate;
}

module.exports = { SCRAPINGBEE_ACKNOWLEDGED_EXHAUSTION, isScrapingBeeExhaustionAcknowledged };
