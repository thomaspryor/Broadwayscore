#!/usr/bin/env node
/**
 * audit-geo-bots.js — Weekly bot-country detector
 *
 * Queries GA4 for the last 7 days of country-level engagement metrics, flags
 * countries matching the bot signature (high sessions + low engagement + low
 * duration + ~1.0 pages/session), and alerts if any NEW bot country has
 * appeared since last audit (compared against data/audit/known-bot-geos.json).
 *
 * On new bot detection: routes each newly-detected country through
 * owner-alert-router (disposition: digest — per-country conditionKey, so a
 * country nobody has triaged yet queues one Daily Digest line per 7-day
 * cooldown instead of a fresh line every week). Silent if no new bots.
 *
 * Run weekly via .github/workflows/weekly-geo-audit.yml.
 *
 * Env: GA4_PROPERTY_ID, GA_SERVICE_ACCOUNT_KEY (base64) or GA_KEY_FILE
 */

const fs = require('fs');
const path = require('path');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { routeAlert } = require('./lib/owner-alert-router');
const { fetchEngagedSessionsSummary } = require('./lib/ga4-engaged-sessions');

const KNOWN_BOTS_FILE = path.join(__dirname, '..', 'data', 'audit', 'known-bot-geos.json');

// Bot signature — all three signals must align.
// Engagement alone caused a false positive for the US (10.8% engagement but
// 33.6s avg session + 1.52 pages/session = clear real-user behavior).
// Real bots hit one URL and leave: <10s duration, ~1.0 pages/session.
const BOT_THRESHOLDS = {
  minSessions: 25,         // ignore stat-noise countries
  maxEngagementPct: 15,    // real countries are 40-70%
  maxDurationSeconds: 15,  // bots don't read pages; real users average 30s+
  maxPagesPerSession: 1.1, // bots hit one URL; real users click around
};

function getClient() {
  if (process.env.GA_SERVICE_ACCOUNT_KEY) {
    const decoded = Buffer.from(process.env.GA_SERVICE_ACCOUNT_KEY, 'base64').toString('utf8');
    return new BetaAnalyticsDataClient({ credentials: JSON.parse(decoded) });
  }
  if (process.env.GA_KEY_FILE) {
    return new BetaAnalyticsDataClient({ keyFilename: process.env.GA_KEY_FILE });
  }
  return new BetaAnalyticsDataClient();
}

async function fetchGeoStats(client, propertyId, days = 7) {
  const [res] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'country' }],
    metrics: [
      { name: 'sessions' },
      { name: 'engagementRate' },
      { name: 'averageSessionDuration' },
      { name: 'screenPageViewsPerSession' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 50,
  });
  return (res.rows || []).map((r) => ({
    country: r.dimensionValues[0]?.value || '(not set)',
    sessions: parseInt(r.metricValues[0]?.value || '0'),
    engagementPct: parseFloat(r.metricValues[1]?.value || '0') * 100,
    durationSeconds: parseFloat(r.metricValues[2]?.value || '0'),
    pagesPerSession: parseFloat(r.metricValues[3]?.value || '0'),
  }));
}

function isBotGeo(stats) {
  return (
    stats.sessions >= BOT_THRESHOLDS.minSessions &&
    stats.engagementPct < BOT_THRESHOLDS.maxEngagementPct &&
    stats.durationSeconds < BOT_THRESHOLDS.maxDurationSeconds &&
    stats.pagesPerSession < BOT_THRESHOLDS.maxPagesPerSession
  );
}

function loadKnownBots() {
  if (process.argv.includes('--test')) {
    console.log('[--test] Ignoring known-bot-geos.json — every detected bot will alert.');
    return new Set();
  }
  const raw = JSON.parse(fs.readFileSync(KNOWN_BOTS_FILE, 'utf8'));
  return new Set(raw.knownBots || []);
}

function formatStats(s) {
  return `${s.sessions.toLocaleString()} sessions • ${s.engagementPct.toFixed(1)}% engagement • ${s.durationSeconds.toFixed(1)}s • ${s.pagesPerSession.toFixed(2)} pages/session`;
}

async function main() {
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) {
    console.error('GA4_PROPERTY_ID not set');
    process.exit(1);
  }

  const client = getClient();

  // BRO-44 — report the headline traffic KPI (engaged sessions, not raw
  // sessions) at the top of this cron's output. This is the one recurring
  // GA4 job in the repo, so it's the natural default location for the
  // headline number. See scripts/lib/ga4-engaged-sessions.js.
  try {
    const engaged = await fetchEngagedSessionsSummary(client, propertyId, {
      startDate: '7daysAgo',
      endDate: 'today',
    });
    console.log(
      `Headline KPI — Engaged Sessions (7d): ${engaged.headline.toLocaleString()} ` +
        `(raw sessions: ${engaged.totalSessions.toLocaleString()}, ` +
        `${engaged.inflationRatio ? engaged.inflationRatio.toFixed(1) + 'x' : 'n/a'} inflation; ` +
        `Direct channel: ${engaged.direct.sessions.toLocaleString()} raw / ` +
        `${engaged.direct.engagedSessions.toLocaleString()} engaged)\n`
    );
  } catch (err) {
    console.error(`Headline KPI fetch failed (non-fatal): ${err.message}`);
  }

  const stats = await fetchGeoStats(client, propertyId, 7);
  console.log(`Geo audit: ${stats.length} countries in last 7 days\n`);

  const bots = stats.filter(isBotGeo);
  const known = loadKnownBots();
  const newBots = bots.filter((b) => !known.has(b.country));
  const knownBotsSeen = bots.filter((b) => known.has(b.country));

  console.log(`Known bots seen this week (${knownBotsSeen.length}):`);
  for (const b of knownBotsSeen) console.log(`  ${b.country}: ${formatStats(b)}`);
  console.log(`\nNew bot countries (${newBots.length}):`);
  for (const b of newBots) console.log(`  ${b.country}: ${formatStats(b)}`);

  if (newBots.length === 0) {
    console.log('\nNo new bot countries — silent success.');
    return;
  }

  // Route each new bot country through owner-alert-router individually so a
  // country that's still undispositioned after 7 days re-queues instead of
  // going silent forever, while a country the owner just triaged doesn't
  // requeue every week until it's actually added to known-bot-geos.json.
  for (const b of newBots) {
    await routeAlert({
      conditionKey: `geo-bots:${b.country}`,
      title: `New bot country detected: ${b.country}`,
      description:
        `Weekly geo audit found ${b.country} matching the bot signature ` +
        `(${formatStats(b)}; thresholds: ≥${BOT_THRESHOLDS.minSessions} sessions, ` +
        `<${BOT_THRESHOLDS.maxEngagementPct}% engagement, ` +
        `<${BOT_THRESHOLDS.maxDurationSeconds}s avg session, ` +
        `<${BOT_THRESHOLDS.maxPagesPerSession} pages/session). ` +
        `Add to data/audit/known-bot-geos.json + memory/analytics-real-users-segment.md ` +
        `+ the 3 PostHog Real Users insights + the GA4 Real Users comparison.`,
      severity: 'warning',
      disposition: 'digest',
    });
  }

  console.log(`\nQueued digest alert(s) for ${newBots.length} new bot countr${newBots.length === 1 ? 'y' : 'ies'}.`);
}

main().catch((err) => {
  console.error('Geo audit failed:', err.message);
  process.exit(1);
});
