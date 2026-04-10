#!/usr/bin/env node
/**
 * audit-geo-bots.js — Weekly bot-country detector
 *
 * Queries GA4 for the last 7 days of country-level engagement metrics, flags
 * countries matching the bot signature (high sessions + low engagement + low
 * duration + ~1.0 pages/session), and alerts if any NEW bot country has
 * appeared since last audit (compared against data/audit/known-bot-geos.json).
 *
 * On new bot detection: sends a Discord alert + email via lib/discord-notify
 * (sendAlert with email:true). Silent if no new bots.
 *
 * Run weekly via .github/workflows/weekly-geo-audit.yml.
 *
 * Env: GA4_PROPERTY_ID, GA_SERVICE_ACCOUNT_KEY (base64) or GA_KEY_FILE,
 *      DISCORD_WEBHOOK_ALERTS, RESEND_API_KEY, OWNER_EMAIL
 */

const fs = require('fs');
const path = require('path');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { sendAlert } = require('./lib/discord-notify');

const KNOWN_BOTS_FILE = path.join(__dirname, '..', 'data', 'audit', 'known-bot-geos.json');

// Bot signature — sessions volume gate + engagement gate.
// Engagement-rate alone is very discriminating: every real-human country
// in the Apr 2026 audit was >40% engagement, every bot country was <15%.
// Duration/pages-per-session are unreliable (bot waves vary; some load
// pages slowly, some hit one URL and leave).
const BOT_THRESHOLDS = {
  minSessions: 25,       // ignore stat-noise countries
  maxEngagementPct: 15,  // real countries are 40-70%
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
    stats.engagementPct < BOT_THRESHOLDS.maxEngagementPct
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

  // Alert: Discord + email in one call
  const fields = newBots.map((b) => ({
    name: b.country,
    value: formatStats(b),
    inline: false,
  }));

  await sendAlert({
    title: `New bot countries detected (${newBots.length})`,
    description:
      `Weekly geo audit found ${newBots.length} new countr${newBots.length === 1 ? 'y' : 'ies'} ` +
      `matching the bot signature (≥${BOT_THRESHOLDS.minSessions} sessions, ` +
      `<${BOT_THRESHOLDS.maxEngagementPct}% engagement). ` +
      `Add to data/audit/known-bot-geos.json + memory/analytics-real-users-segment.md ` +
      `+ the 3 PostHog Real Users insights + the GA4 Real Users comparison.`,
    severity: 'warning',
    fields,
    email: true,
  });

  console.log(`\nAlerted via Discord + email about ${newBots.length} new bot countries.`);
}

main().catch((err) => {
  console.error('Geo audit failed:', err.message);
  process.exit(1);
});
