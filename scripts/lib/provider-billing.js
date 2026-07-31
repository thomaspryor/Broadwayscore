/**
 * provider-billing.js — the one reader of scraping-provider billing APIs.
 *
 * Scraping Cost System v2 (plan: claude-outputs/scraping-cost-system-v2-plan.md,
 * owner-approved 2026-07-30). Billing APIs are the only spend numbers that
 * cannot lie; sampled log attribution drifts. Every consumer of provider
 * billing (daily reconciliation, weekly cost report) goes through this module
 * so the parsers cannot diverge.
 *
 * Pure parsers are exported separately from fetchers (pattern:
 * browserbase-live-usage.js countRecentSessions) so provider-billing.test.mjs
 * exercises them against captured fixtures. Every fetcher returns null on ANY
 * failure — callers must treat null as "unknown", never as zero. A zero-spend
 * day and an unmeasurable day are different facts (fail-closed rule from the
 * plan review).
 */
'use strict';

const FETCH_TIMEOUT_MS = 20000;

async function _getJson(url, headers = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------- pure parsers (fixture-tested) ----------

/**
 * BD /zone/cost response: { "<customer>": { custom: { cost, reqs_serp?, reqs_unblocker?, bw } } }
 * @returns {{cost:number, reqs:number}|null}
 */
function parseBdZoneCost(json) {
  if (!json || typeof json !== 'object') return null;
  let cost = 0;
  let reqs = 0;
  let sawAny = false;
  for (const entry of Object.values(json)) {
    const c = entry && entry.custom;
    if (!c || typeof c !== 'object') continue;
    sawAny = true;
    if (typeof c.cost === 'number') cost += c.cost;
    for (const [k, v] of Object.entries(c)) {
      if (k.startsWith('reqs_') && typeof v === 'number') reqs += v;
    }
  }
  // An empty object {} is BD's real answer for "no traffic in this window" —
  // that is a legitimate $0 day, not an unknown.
  return sawAny || Object.keys(json).length === 0 ? { cost, reqs } : null;
}

/** BD /customer/balance → {balance, pendingCosts}|null */
function parseBdBalance(json) {
  if (!json || typeof json.balance !== 'number') return null;
  return { balance: json.balance, pendingCosts: json.pending_costs ?? 0 };
}

/**
 * Browserbase /v1/sessions returns every session ever (list or {data:[...]}).
 * Count sessions created on a UTC day ("YYYY-MM-DD").
 * @returns {number|null} null when the payload shape is unrecognizable
 */
function countBbSessionsOnDay(json, dayIso) {
  const items = Array.isArray(json) ? json : json && Array.isArray(json.data) ? json.data : null;
  if (!items) return null;
  return items.filter((s) => typeof s?.createdAt === 'string' && s.createdAt.startsWith(dayIso)).length;
}

/** ScrapingBee /usage → {cycleUsed, cap, renewalDate}|null */
function parseSbUsage(json) {
  if (!json || typeof json.used_api_credit !== 'number') return null;
  return {
    cycleUsed: json.used_api_credit,
    cap: json.max_api_credit ?? null,
    renewalDate: (json.renewal_subscription_date || '').slice(0, 10) || null,
  };
}

/** ScrapingDog /account → {cycleUsed, limit, daysToRenewal}|null */
function parseSdAccount(json) {
  if (!json || typeof json.requestUsed !== 'number') return null;
  return {
    cycleUsed: json.requestUsed,
    limit: json.requestLimit ?? null,
    daysToRenewal: typeof json.validity === 'number' ? json.validity : null,
  };
}

// ---------- fetchers (null on any failure) ----------

async function fetchBdZoneCostDay(zone, dayIso, token) {
  if (!zone || !token) return null;
  const json = await _getJson(
    `https://api.brightdata.com/zone/cost?zone=${encodeURIComponent(zone)}&from=${dayIso}&to=${dayIso}`,
    { Authorization: `Bearer ${token}` },
  );
  return parseBdZoneCost(json);
}

async function fetchBdBalance(token) {
  if (!token) return null;
  return parseBdBalance(await _getJson('https://api.brightdata.com/customer/balance', { Authorization: `Bearer ${token}` }));
}

async function fetchBbSessionCountForDay(apiKey, projectId, dayIso) {
  if (!apiKey || !projectId) return null;
  const json = await _getJson(
    `https://api.browserbase.com/v1/sessions?projectId=${encodeURIComponent(projectId)}`,
    { 'X-BB-API-Key': apiKey },
  );
  return json == null ? null : countBbSessionsOnDay(json, dayIso);
}

async function fetchSbUsage(apiKey) {
  if (!apiKey) return null;
  return parseSbUsage(await _getJson(`https://app.scrapingbee.com/api/v1/usage?api_key=${encodeURIComponent(apiKey)}`));
}

async function fetchSdAccount(apiKey) {
  if (!apiKey) return null;
  return parseSdAccount(await _getJson(`https://api.scrapingdog.com/account?api_key=${encodeURIComponent(apiKey)}`));
}

module.exports = {
  parseBdZoneCost,
  parseBdBalance,
  countBbSessionsOnDay,
  parseSbUsage,
  parseSdAccount,
  fetchBdZoneCostDay,
  fetchBdBalance,
  fetchBbSessionCountForDay,
  fetchSbUsage,
  fetchSdAccount,
};
