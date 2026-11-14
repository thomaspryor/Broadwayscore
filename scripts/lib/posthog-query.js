/**
 * posthog-query.js — Shared PostHog HogQL query helpers.
 *
 * Single source of truth for all PostHog query logic.
 * Used by posthog-weekly-insights.js, posthog-friction-analyzer.js,
 * analyze-traffic-sources.js, lib/traffic-history.js and (phQueryFull +
 * REAL_USERS_WHERE) posthog-adhoc-query.js.
 *
 * Env: POSTHOG_PERSONAL_API_KEY
 */

const API_BASE = 'https://us.posthog.com';
const PROJECT_ID = '332742';

const RETRYABLE_STATUS = new Set([429, 502, 503]);
const RETRY_DELAYS_MS = [10000, 30000, 90000];

function getApiKey() {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!key) throw new Error('POSTHOG_PERSONAL_API_KEY not set');
  return key;
}

/**
 * Full query response ({ columns, results, types, ... }). Every fixed-query
 * caller below knows its own column order and only wants `results`, so they
 * keep using phQuery; scripts/posthog-adhoc-query.js needs the column names
 * to head a table for a statement it has never seen (BRO-4327).
 */
async function phQueryFull(hogql, opts = {}) {
  const doFetch = opts.fetch || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await doFetch(`${API_BASE}/api/projects/${PROJECT_ID}/query/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
      // A hung socket would otherwise run to the calling job's timeout, which
      // reports `cancelled` and emits nothing; 4 min still outlasts a PostHog
      // 504 (~5 min is the observed worst case, and callers retry on timeout).
      signal: AbortSignal.timeout(240000),
    });
    // BRO-5998: PostHog sheds load with 503 clickhouse_at_capacity (and 429/502);
    // it failed the weekly gate monitor twice in a row. Transient: back off, retry.
    if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt >= RETRY_DELAYS_MS.length) break;
    console.error(`[posthog-query] HTTP ${res.status}, retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${RETRY_DELAYS_MS[attempt] / 1000}s`);
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  // Body sliced: a 504 comes back as a full HTML page, which would otherwise
  // land verbatim in a table cell or a log line.
  if (!res.ok) throw new Error(`PostHog API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

async function phQuery(hogql) {
  const data = await phQueryFull(hogql);
  return data.results || [];
}

// Real Users lens (memory/feedback_analytics_real_users_lens.md): drop the
// owner (is_owner super-property, set via ?bwsc-owner=1) and the geos that are
// almost entirely bot traffic. is_owner is an EVENT property (posthog.register
// in AnalyticsWrapper.tsx creates no person profile): this read
// person.properties until BRO-4967 and so excluded nothing (2026-10-10: 56
// owner-stamped events in 30 days, 0 persons with the property).
// The ONE definition — analyze-gate-cold-start.js,
// analyze-email-gate-funnel.js and analyze-traffic-sources.js import it; append
// to a WHERE clause on `events`. Keep data/audit/known-bot-geos.json in step.
//   SG/CN/VN: original lens (2026-04).
//   HK: added 2026-09-15 (BRO-3419) — 100-741 sessions/week since Jun 29 with
//       sessions == users every week (one page per visitor, zero repeats) while
//       GA4 saw ~5 HK sessions/week; PostHog-only bots that GA4 filters out.
const REAL_USERS_WHERE = `
  (JSONExtractString(properties,'$geoip_country_code') NOT IN ('SG','CN','VN','HK')
   OR JSONExtractString(properties,'$geoip_country_code') = '')
  AND coalesce(JSONExtractString(properties,'is_owner'),'') != 'true'`;

async function authCheck() {
  const res = await fetch(`${API_BASE}/api/projects/${PROJECT_ID}/`, {
    signal: AbortSignal.timeout(60000),
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

// Real Users lens like getRageClickDetails: the owner's own visual-QA
// clicking and bot geos are not user friction (BRO-340).
async function getRageClicks() {
  return phQuery(`
    SELECT properties.$pathname AS page, count() AS rage_clicks
    FROM events
    WHERE event = '$rageclick' AND timestamp > now() - interval 7 day
      AND ${REAL_USERS_WHERE}
    GROUP BY page ORDER BY rage_clicks DESC LIMIT 10
  `);
}

// Rage clicks per clicked element — for friction analysis. Row shape is
// documented in scripts/lib/rage-click-summary.js (its only consumer). Real
// Users lens + distinct visitors so one person (or the owner) can't file a
// card; tag/href/nearest id so the card names the element (BRO-3657 cluster).
// The HAVING floor matches MIN_RAGE_USERS and is load-bearing: on 2026-10-12
// the same SELECT without it returned PostHog API 500 on every try, while
// with it the query answered (some single-visitor row breaks the response).
// Known limit: the floor is per exact path, so a widget broken on many show
// pages with one visitor each never qualifies. Collapsing /show/<id> to
// /show/* in HogQL (replaceRegexpAll, multiIf(match(...)), or a subquery)
// also returned 500 on every try that day; pageKeyForPath groups the rows
// that do qualify.
async function getRageClickDetails() {
  return phQuery(`
    SELECT
      properties.$pathname AS page,
      properties.$el_text AS element_text,
      arrayElement(elements_chain_elements, 1) AS tag,
      elements_chain_href AS href,
      arrayElement(elements_chain_ids, 1) AS nearest_id,
      count() AS n,
      count(DISTINCT person_id) AS users
    FROM events
    WHERE event = '$rageclick' AND timestamp > now() - interval 7 day
      AND ${REAL_USERS_WHERE}
    GROUP BY page, element_text, tag, href, nearest_id
    HAVING users >= 2
    ORDER BY n DESC LIMIT 25
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
  // HeaderSearch sends query only on a miss: zero results, or only fuzzy
  // guesses (fuzzy_only, has_results true). query IS NOT NULL covers both.
  return phQuery(`
    SELECT lower(trim(properties.query)) AS query, count() AS cnt
    FROM events
    WHERE event = 'search_performed'
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

// Gate modal funnel. Modal-only for email_captured: that event also fires from
// inline header/footer forms (no `trigger` property), which would overstate
// gate captures. gate_modal_shown/dismissed only ever fire from the modal, so
// they're unaffected. See docs/experiments/gate-cold-start.md.
async function getGateFunnel() {
  return phQuery(`
    SELECT event, count() AS n, count(DISTINCT person_id) AS users
    FROM events
    WHERE event IN ('gate_modal_shown', 'gate_modal_dismissed', 'email_captured')
      AND (event != 'email_captured' OR JSONExtractString(properties,'trigger') != '')
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
  phQuery,
  phQueryFull,
  REAL_USERS_WHERE,
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
