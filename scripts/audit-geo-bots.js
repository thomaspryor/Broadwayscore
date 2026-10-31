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
 * PostHog leg (BRO-3432): GA4 filters some bot traffic that PostHog still
 * ingests (Hong Kong ran 11 weeks unflagged), so the same audit also runs a
 * HogQL country query and flags sessions >= 100 with users/session >= 0.98
 * and pageviews/session <= 1.05 (scripts/lib/posthog-geo-bots.js). Skipped
 * when POSTHOG_PERSONAL_API_KEY is unset locally (a missing key in CI, or a
 * PostHog query failure, still lets the GA4 alerts go out, then fails the
 * run so the gap is visible).
 *
 * Run weekly via .github/workflows/weekly-geo-audit.yml.
 *
 * Env: GA4_PROPERTY_ID, GA_SERVICE_ACCOUNT_KEY (base64) or GA_KEY_FILE,
 *      POSTHOG_PERSONAL_API_KEY (optional)
 */

const fs = require('fs');
const path = require('path');
const { getGaClient } = require('./lib/ga4-client');
const { routeAlert } = require('./lib/owner-alert-router');
const { fetchAndQueueTrafficSummary } = require('./lib/daily-digest-ga4-traffic');
const { phQuery } = require('./lib/posthog-query');
const {
  buildPosthogGeoQuery, parsePosthogGeoRows, isPosthogBotGeo, formatPosthogStats,
  partitionByKnown, buildGeoBotAlerts,
} = require('./lib/posthog-geo-bots');

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

const getClient = getGaClient;

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

  // BRO-44 / BRO-2502: query once for the log and the owner's morning digest.
  // The weekly workflow already persists the digest queue, even on failure.
  try {
    const engaged = await fetchAndQueueTrafficSummary(client, propertyId);
    console.log(
      `Headline KPI — Engaged Sessions (7d): ${engaged.headline.toLocaleString()} ` +
        `(raw sessions: ${engaged.totalSessions.toLocaleString()}, ` +
        `${engaged.inflationRatio ? engaged.inflationRatio.toFixed(1) + 'x' : 'n/a'} inflation; ` +
        `Direct channel: ${engaged.direct.sessions.toLocaleString()} raw / ` +
        `${engaged.direct.engagedSessions.toLocaleString()} engaged)\n`
    );
  } catch (err) {
    console.error(`Headline KPI fetch/digest failed (non-fatal): ${err.message}`);
  }

  const stats = await fetchGeoStats(client, propertyId, 7);
  console.log(`Geo audit: ${stats.length} countries in last 7 days\n`);

  const bots = stats.filter(isBotGeo);
  const known = loadKnownBots();
  const { newBots, knownSeen: knownBotsSeen } = partitionByKnown(bots, known);

  console.log(`Known bots seen this week (${knownBotsSeen.length}):`);
  for (const b of knownBotsSeen) console.log(`  ${b.country}: ${formatStats(b)}`);
  console.log(`\nNew bot countries (${newBots.length}):`);
  for (const b of newBots) console.log(`  ${b.country}: ${formatStats(b)}`);

  // PostHog leg (BRO-3432).
  let phNew = [];
  let posthogError = null;
  if (!process.env.POSTHOG_PERSONAL_API_KEY) {
    // In CI a missing key would silently recreate the blind spot this leg
    // exists to close, so it fails the run (after the GA4 alerts go out).
    if (process.env.CI) posthogError = new Error('POSTHOG_PERSONAL_API_KEY not set in CI');
    console.log('\nPostHog leg skipped: POSTHOG_PERSONAL_API_KEY not set.');
  } else {
    try {
      const rows = parsePosthogGeoRows(await phQuery(buildPosthogGeoQuery(7)));
      const phBots = rows.filter((r) => isPosthogBotGeo(r));
      const split = partitionByKnown(phBots, known);
      phNew = split.newBots;
      console.log(`\nPostHog geo audit: ${rows.length} countries in last 7 days`);
      console.log(`Known bots seen in PostHog (${split.knownSeen.length}):`);
      for (const b of split.knownSeen) console.log(`  ${b.country}: ${formatPosthogStats(b)}`);
      console.log(`New PostHog bot countries (${phNew.length}):`);
      for (const b of phNew) console.log(`  ${b.country}: ${formatPosthogStats(b)}`);
    } catch (err) {
      posthogError = err;
      console.error(`\nPostHog geo query failed: ${err.message}`);
    }
  }

  const gaThresholdText = `≥${BOT_THRESHOLDS.minSessions} sessions, ` +
    `<${BOT_THRESHOLDS.maxEngagementPct}% engagement, ` +
    `<${BOT_THRESHOLDS.maxDurationSeconds}s avg session, ` +
    `<${BOT_THRESHOLDS.maxPagesPerSession} pages/session`;
  const alerts = buildGeoBotAlerts(
    newBots.map((b) => ({ country: b.country, text: formatStats(b) })),
    phNew.map((b) => ({ country: b.country, text: formatPosthogStats(b) })),
    gaThresholdText,
  );

  if (alerts.length === 0) {
    console.log('\nNo new bot countries — silent success.');
  } else {
    // Route each new bot country through owner-alert-router individually so a
    // country that's still undispositioned after 7 days re-queues instead of
    // going silent forever, while a country the owner just triaged doesn't
    // requeue every week until it's actually added to known-bot-geos.json.
    for (const alert of alerts) await routeAlert(alert);
    console.log(`\nQueued digest alert(s) for ${alerts.length} new bot countr${alerts.length === 1 ? 'y' : 'ies'}.`);
  }

  if (posthogError) {
    throw new Error(`PostHog leg failed (GA4 leg completed): ${posthogError.message}`);
  }
}

main().catch((err) => {
  console.error('Geo audit failed:', err.message);
  process.exit(1);
});
