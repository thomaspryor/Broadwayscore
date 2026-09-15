/**
 * ga4-client.js — the one place that builds a GA4 Data API client.
 *
 * Credential precedence (same across every caller, so a CI run and a local run
 * resolve identically): GA_SERVICE_ACCOUNT_KEY (base64 JSON, the CI secret) →
 * GA_KEY_FILE (local path) → Application Default Credentials.
 *
 * Previously copied verbatim into query-analytics.js, audit-geo-bots.js and
 * analyze-traffic-sources.js (second-opinion review, BRO-3419) — three copies
 * with two different precedence orders. Callers that want to skip GA4 when
 * nothing is configured use hasGaCredentials() rather than probing env vars.
 */

const { BetaAnalyticsDataClient } = require('@google-analytics/data');

function hasGaCredentials() {
  return Boolean(process.env.GA_SERVICE_ACCOUNT_KEY || process.env.GA_KEY_FILE);
}

function getGaClient() {
  if (process.env.GA_SERVICE_ACCOUNT_KEY) {
    const decoded = Buffer.from(process.env.GA_SERVICE_ACCOUNT_KEY, 'base64').toString('utf8');
    return new BetaAnalyticsDataClient({ credentials: JSON.parse(decoded) });
  }
  if (process.env.GA_KEY_FILE) {
    return new BetaAnalyticsDataClient({ keyFilename: process.env.GA_KEY_FILE });
  }
  return new BetaAnalyticsDataClient();
}

module.exports = { getGaClient, hasGaCredentials };
