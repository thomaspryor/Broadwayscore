/**
 * posthog-query.js — Shared PostHog HogQL query helpers.
 *
 * Single source of truth for all PostHog query logic.
 * Used by posthog-weekly-insights.js and posthog-friction-analyzer.js.
 *
 * Env: POSTHOG_PERSONAL_API_KEY
 */

const API_BASE = 'https://us.posthog.com';
const PROJECT_ID = '332742';

function getApiKey() {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!key) throw new Error('POSTHOG_PERSONAL_API_KEY not set');
  return key;
}

async function phQuery(hogql) {
  const res = await fetch(`${API_BASE}/api/projects/${PROJECT_ID}/query/`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
  });
  if (!res.ok) throw new Error(`PostHog API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.results || [];
}

async function authCheck() {
  const res = await fetch(`${API_BASE}/api/projects/${PROJECT_ID}/`, {
    headers: { 'Authorization': `Bearer ${getApiKey()}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PostHog auth check failed (${res.status}): ${body}`);
  }
}

// Per-query error isolation — returns [] on failure, logs to stderr.
function tracked(name, fn) {
  return fn().catch(e => {
    console.error(`[posthog] ${name} failed: ${e.message}`);
    return [];
  });
}

// ── Query functions ──────────────────────────────────────────────────────

async function getTopPages() {
  return phQuery(`
    SELECT properties.$pathname AS page, count() AS views, count(DISTINCT person_id) AS users
    FROM events
    WHERE event = '$pageview' AND timestamp > now() - interval 7 day
    GROUP BY page ORDER BY views DESC LIMIT 20
  `);
}

async function getTopEvents() {
  return phQuery(`
    SELECT event, count() AS total, count(DISTINCT person_id) AS users
    FROM events
    WHERE timestamp > now() - interval 7 day
      AND event NOT IN ('$pageview', '$pageleave', '$autocapture', '$rageclick', '$feature_flag_called')
    GROUP BY event ORDER BY total DESC LIMIT 15
  `);
}

async function getTrafficSummary() {
  return phQuery(`
    SELECT
      count(DISTINCT person_id) AS unique_users,
      countIf(event = '$pageview') AS pageviews,
      countIf(event = '$session_start') AS sessions
    FROM events
    WHERE timestamp > now() - interval 7 day
  `);
}

async function getRageClicks() {
  return phQuery(`
    SELECT properties.$pathname AS page, count() AS rage_clicks
    FROM events
    WHERE event = '$rageclick' AND timestamp > now() - interval 7 day
    GROUP BY page ORDER BY rage_clicks DESC LIMIT 10
  `);
}

// Rage clicks with element text — for friction analysis.
async function getRageClickDetails() {
  return phQuery(`
    SELECT
      properties.$pathname AS page,
      properties.$el_text AS element_text,
      count() AS n
    FROM events
    WHERE event = '$rageclick' AND timestamp > now() - interval 7 day
    GROUP BY page, element_text ORDER BY n DESC LIMIT 15
  `);
}

// Search stats — counts only, no raw query text (privacy).
async function getSearchStats() {
  return phQuery(`
    SELECT
      count() AS total_searches,
      countIf(properties.has_results = false) AS zero_results,
      count(DISTINCT person_id) AS unique_searchers
    FROM events
    WHERE event = 'search_performed' AND timestamp > now() - interval 7 day
  `);
}

// Zero-results search terms (raw query text) — surfaces shows users look for
// but can't find. Unlike getSearchStats (counts only), this intentionally
// returns the query text: search terms are show-title lookups, not PII, and the
// raw term is what lets the friction analyzer flag missing productions.
async function getZeroResultsSearches() {
  // Group on lower(trim(query)) so case/whitespace variants of the same term
  // don't fragment the count (and under-rank a real missing show).
  return phQuery(`
    SELECT lower(trim(properties.query)) AS query, count() AS cnt
    FROM events
    WHERE event = 'search_performed'
      AND properties.has_results = false
      AND properties.query IS NOT NULL
      AND trim(properties.query) != ''
      AND timestamp > now() - interval 7 day
    GROUP BY query ORDER BY cnt DESC LIMIT 50
  `);
}

// Ticket clicks — correct event name (ticket_click, not ticket_link_click).
async function getTicketClicks() {
  return phQuery(`
    SELECT properties.show_name AS show, properties.platform AS platform, count() AS clicks
    FROM events
    WHERE event = 'ticket_click' AND timestamp > now() - interval 7 day
    GROUP BY show, platform ORDER BY clicks DESC LIMIT 15
  `);
}

// Ticket clicks on closed shows — should be zero; any result = badge shown on closed show.
async function getClosedShowTicketClicks() {
  return phQuery(`
    SELECT properties.show_name AS show, properties.platform AS platform, count() AS clicks
    FROM events
    WHERE event = 'ticket_click'
      AND properties.show_status = 'closed'
      AND timestamp > now() - interval 7 day
    GROUP BY show, platform ORDER BY clicks DESC LIMIT 10
  `);
}

// Gate modal funnel.
async function getGateFunnel() {
  return phQuery(`
    SELECT event, count() AS n, count(DISTINCT person_id) AS users
    FROM events
    WHERE event IN ('gate_modal_shown', 'gate_modal_dismissed', 'email_captured')
      AND timestamp > now() - interval 7 day
    GROUP BY event ORDER BY n DESC
  `);
}

// Beat-the-Critics funnel.
async function getBtcFunnel() {
  return phQuery(`
    SELECT event, count() AS n, count(DISTINCT person_id) AS users
    FROM events
    WHERE event LIKE 'btc_%' AND timestamp > now() - interval 7 day
    GROUP BY event ORDER BY users DESC
  `);
}

// Promo click breakdown by placement slot.
async function getPromoClicks() {
  return phQuery(`
    SELECT properties.placement AS placement, properties.variant AS variant, count() AS n
    FROM events
    WHERE event = 'promo_click' AND timestamp > now() - interval 7 day
      AND properties.placement IS NOT NULL
    GROUP BY placement, variant ORDER BY n DESC LIMIT 15
  `);
}

module.exports = {
  authCheck,
  tracked,
  getTopPages,
  getTopEvents,
  getTrafficSummary,
  getRageClicks,
  getRageClickDetails,
  getSearchStats,
  getZeroResultsSearches,
  getTicketClicks,
  getClosedShowTicketClicks,
  getGateFunnel,
  getBtcFunnel,
  getPromoClicks,
};
