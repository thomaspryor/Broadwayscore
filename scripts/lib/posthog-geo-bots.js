/**
 * posthog-geo-bots.js — pure helpers for the PostHog leg of the weekly geo
 * bot audit (scripts/audit-geo-bots.js).
 *
 * BRO-3432: the audit only read GA4, so bots that Google filters out but
 * PostHog ingests were invisible to it. Hong Kong ran 11 weeks at 100-741
 * PostHog sessions/week with sessions == users every week (one pageview per
 * visitor, zero repeats) while GA4 saw ~5 HK sessions/week (BRO-3419).
 *
 * Signature: per country over the window, sessions >= 100, users/sessions
 * >= 0.98 (almost every session is a brand-new visitor) and
 * pageviews/session <= 1.05 (one page and gone).
 */

const POSTHOG_BOT_THRESHOLDS = {
  minSessions: 100,
  minUsersPerSession: 0.98,
  maxPageviewsPerSession: 1.05,
};

// Explicit LIMIT: HogQL silently caps GROUP BY results at ~100 rows without
// one (cloud-memory/feedback_posthog_hogql_default_row_limit.md).
const ROW_LIMIT = 500;

// No REAL_USERS_WHERE here: that lens drops the known bot geos, and the audit
// needs to see them to report "known bots seen this week". The owner is still
// excluded (same is_owner event property the lens uses).
function buildPosthogGeoQuery(days = 7) {
  const d = Math.max(1, Math.floor(Number(days) || 7));
  return `
    SELECT coalesce(nullIf(properties.$geoip_country_name, ''), '(unknown)') AS country,
           count(DISTINCT $session_id) AS sessions,
           count(DISTINCT person_id) AS users,
           count() AS pageviews,
           any(properties.$geoip_country_code) AS country_code
    FROM events
    WHERE event = '$pageview'
      AND timestamp >= now() - interval ${d} day
      AND $session_id != ''
      AND coalesce(JSONExtractString(properties,'is_owner'),'') != 'true'
    GROUP BY country
    ORDER BY sessions DESC
    LIMIT ${ROW_LIMIT}`;
}

function parsePosthogGeoRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  // HogQL truncates at LIMIT without saying so; a full page means countries
  // may be missing, so refuse rather than report a partial audit.
  if (list.length >= ROW_LIMIT) {
    throw new Error(`PostHog geo query hit the ${ROW_LIMIT}-row limit — countries may be missing`);
  }
  return list.map(([country, sessions, users, pageviews, countryCode]) => {
    const s = Number(sessions) || 0;
    const u = Number(users) || 0;
    const pv = Number(pageviews) || 0;
    return {
      country: country == null || country === '' ? '(unknown)' : String(country),
      countryCode: countryCode ? String(countryCode) : '',
      sessions: s,
      users: u,
      pageviews: pv,
      usersPerSession: s > 0 ? u / s : 0,
      pageviewsPerSession: s > 0 ? pv / s : 0,
    };
  });
}

function isPosthogBotGeo(row, t = POSTHOG_BOT_THRESHOLDS) {
  if (!row || row.country === '(unknown)') return false;
  return (
    row.sessions >= t.minSessions &&
    row.usersPerSession >= t.minUsersPerSession &&
    row.pageviewsPerSession <= t.maxPageviewsPerSession
  );
}

function formatPosthogStats(r) {
  return `${r.countryCode ? `[${r.countryCode}] ` : ''}${r.sessions.toLocaleString()} PostHog sessions • ${r.users.toLocaleString()} users ` +
    `(${r.usersPerSession.toFixed(2)} users/session) • ${r.pageviewsPerSession.toFixed(2)} pageviews/session`;
}

/**
 * Split detected bot rows into new vs already-known countries.
 * @param {Array<{country:string}>} bots
 * @param {Set<string>} known
 */
function partitionByKnown(bots, known) {
  const newBots = [];
  const knownSeen = [];
  for (const b of bots) (known.has(b.country) ? knownSeen : newBots).push(b);
  return { newBots, knownSeen };
}

/**
 * One owner-alert-router payload per NEW bot country across both sources.
 * The conditionKey is the GA4 path's `geo-bots:<country>`, so a country both
 * sources flag queues one digest line, and a country already alerted from
 * GA4 keeps its cooldown.
 *
 * @param {Array<{country:string, text:string}>} gaNew     GA4 rows, pre-formatted
 * @param {Array<{country:string, text:string}>} posthogNew PostHog rows, pre-formatted
 * @param {string} gaThresholdText
 */
function buildGeoBotAlerts(gaNew, posthogNew, gaThresholdText) {
  const byCountry = new Map();
  for (const b of gaNew || []) {
    byCountry.set(b.country, { ga: b.text, posthog: null });
  }
  for (const b of posthogNew || []) {
    const e = byCountry.get(b.country) || { ga: null, posthog: null };
    e.posthog = b.text;
    byCountry.set(b.country, e);
  }
  const t = POSTHOG_BOT_THRESHOLDS;
  const phThresholds = `≥${t.minSessions} sessions, ≥${t.minUsersPerSession} users/session, ` +
    `≤${t.maxPageviewsPerSession} pageviews/session`;
  return [...byCountry.entries()].map(([country, e]) => {
    const parts = [];
    if (e.ga) parts.push(`GA4: ${e.ga} (thresholds: ${gaThresholdText})`);
    if (e.posthog) parts.push(`PostHog: ${e.posthog} (thresholds: ${phThresholds})`);
    const sources = [e.ga && 'GA4', e.posthog && 'PostHog'].filter(Boolean).join(' + ');
    return {
      conditionKey: `geo-bots:${country}`,
      title: `New bot country detected: ${country}`,
      description:
        `Weekly geo audit found ${country} matching the bot signature in ${sources}. ` +
        `${parts.join(' ')} ` +
        `Add to data/audit/known-bot-geos.json + memory/analytics-real-users-segment.md ` +
        `+ REAL_USERS_WHERE in scripts/lib/posthog-query.js (by ISO code) + the 3 PostHog Real Users insights ` +
        `+ the GA4 Real Users comparison.`,
      severity: 'warning',
      disposition: 'digest',
    };
  });
}

module.exports = {
  POSTHOG_BOT_THRESHOLDS,
  buildPosthogGeoQuery,
  parsePosthogGeoRows,
  isPosthogBotGeo,
  formatPosthogStats,
  partitionByKnown,
  buildGeoBotAlerts,
  ROW_LIMIT,
};
