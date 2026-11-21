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

require('./cloud-proxy'); // BRO-6258: global fetch to ScrapingBee needs the sandbox proxy in cloud

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
  const items = _bbItems(json);
  if (!items) return null;
  if (!bbPayloadCoversDay(items, dayIso)) return null;
  return items.filter((s) => typeof s?.createdAt === 'string' && s.createdAt.startsWith(dayIso)).length;
}

function _bbItems(json) {
  return Array.isArray(json) ? json : json && Array.isArray(json.data) ? json.data : null;
}

/**
 * Pagination guard (BRO-3010 S2). GET /v1/sessions takes no page/limit/cursor
 * parameters (Browserbase API reference + sdk-node SessionListParams, checked
 * 2026-10-17: only `q` and `status`), so there is no next page to fetch. The
 * real risk is the server silently returning a TRUNCATED list (most recent N),
 * which would undercount the target day. A complete list for an account with
 * history always contains a session created BEFORE the target day; when the
 * oldest session in the payload is on/after the target day's start, the day
 * may be cut short, so the count is "unknown" (null), never a low number.
 * An empty list is a complete answer (no sessions ever → 0).
 * @returns {boolean}
 */
function bbPayloadCoversDay(items, dayIso) {
  if (!Array.isArray(items)) return false;
  if (items.length === 0) return true;
  const dayStart = Date.parse(`${dayIso}T00:00:00Z`);
  if (!Number.isFinite(dayStart)) return false;
  let oldest = Infinity;
  for (const s of items) {
    const t = typeof s?.createdAt === 'string' ? Date.parse(s.createdAt) : NaN;
    if (Number.isFinite(t) && t < oldest) oldest = t;
  }
  return oldest < dayStart;
}

/**
 * Sum real session duration (minutes) for sessions CREATED on `dayIso`, from
 * the same /v1/sessions payload countBbSessionsOnDay reads (each item already
 * carries startedAt/endedAt — confirmed live 2026-09-14). A session missing
 * either timestamp (still running, or errored before starting) is skipped —
 * check-provider-spend.js only ever reconciles yesterday (a COMPLETE day, see
 * its own utcYesterday() docstring), so an in-flight session on the target
 * day is the rare exception, not the common case.
 *
 * KNOWN LIMITATION (ship-check finding, BRO-3240): a session that never
 * closes at all (client crash, orphaned session, a Browserbase-side bug) is
 * indistinguishable from one correctly excluded as still-running — it
 * silently contributes 0 minutes forever, with `sessions` still counting it
 * and no `unknown`/flagged state anywhere. Accepted deliberately: the
 * alternative (tracking "how many of today's sessions never got an
 * endedAt" as a distinct signal) reintroduces exactly the kind of
 * cross-call state this fix's plan-review steered away from for a
 * failure mode that, empirically, is rare and small (a few cents/day at
 * most, given real usage here is ~15-20 min/day total).
 *
 * Deliberately NOT sourced from GET /v1/projects/{id}/usage's `browserMinutes`
 * — that field is account-LIFETIME-cumulative (confirmed by health-check.js's
 * own "Credits: Browserbase" check, which labels it "usage trend only (minutes
 * are lifetime-cumulative...)" and never resets), so it cannot answer "how
 * many minutes on THIS day" without an unverified assumption about when/if
 * Browserbase's account-level counter resets. Real per-session timestamps
 * from THIS day answer that directly, with no cycle-boundary guesswork.
 * @returns {number|null} null when the payload shape is unrecognizable
 */
function sumBbMinutesOnDay(json, dayIso) {
  const items = _bbItems(json);
  if (!items) return null;
  if (!bbPayloadCoversDay(items, dayIso)) return null;
  let ms = 0;
  for (const s of items) {
    if (typeof s?.createdAt !== 'string' || !s.createdAt.startsWith(dayIso)) continue;
    if (typeof s.startedAt !== 'string' || typeof s.endedAt !== 'string') continue;
    const dur = new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime();
    if (Number.isFinite(dur) && dur > 0) ms += dur;
  }
  return ms / 60000;
}

/**
 * The ONE place that knows ScrapingBee's /usage field names (BRO-3010).
 * Values pass through untouched (undefined when absent) so every caller keeps
 * its own existing default/coercion — `fields.used || 0`, `Number(fields.max)`
 * — and nothing about its behaviour changes; only the field names moved here.
 * renewalAt is the raw timestamp (health-check.js needs the time of day).
 */
function sbUsageFields(json) {
  const j = json && typeof json === 'object' ? json : {};
  return { used: j.used_api_credit, max: j.max_api_credit, renewalAt: j.renewal_subscription_date };
}

/** ScrapingBee /usage → {cycleUsed, cap, renewalDate}|null */
function parseSbUsage(json) {
  const f = sbUsageFields(json);
  if (typeof f.used !== 'number') return null;
  return {
    cycleUsed: f.used,
    cap: f.max ?? null,
    renewalDate: (f.renewalAt || '').slice(0, 10) || null,
  };
}

const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The weekly cost report's ScrapingBee line (scraper-cost-report.yml), moved
 * off an inline python /usage parser onto sbUsageFields (BRO-3010). Same
 * maths and defaults as the python it replaced: used defaults 0, cap 0/absent
 * reads as 1, days_left = floor((renewal day 00:00Z - now) / 1 day) clamped to
 * >= 1 (30 without a renewal date), projection over a 31-day cycle.
 * @returns {{reportLine: string, renewalLabel: string}}
 *   reportLine = "pct_used|proj_pct|used|cap|projected_abs"; renewalLabel = "Nov 04" | "unknown"
 */
function sbCostReportFields(json, now = new Date()) {
  const f = sbUsageFields(json);
  const used = f.used == null ? 0 : f.used;
  const cap = f.max || 1;
  if (typeof used !== 'number' || typeof cap !== 'number') throw new Error('non-numeric /usage credits');
  const renewal = typeof f.renewalAt === 'string' ? f.renewalAt : '';
  const rMs = renewal ? Date.parse(`${renewal.slice(0, 10)}T00:00:00Z`) : NaN;
  if (renewal && !Number.isFinite(rMs)) throw new Error(`unparseable renewal date ${renewal}`);
  const daysLeft = renewal ? Math.max(Math.floor((rMs - now.getTime()) / 86400000), 1) : 30;
  const daysElapsed = Math.max(31 - daysLeft, 1);
  const projected = renewal ? (used / daysElapsed) * 31 : used;
  const pct = (used / cap) * 100;
  const projPct = (projected / cap) * 100;
  const reportLine = `${pct.toFixed(1)}|${projPct.toFixed(0)}|${used}|${cap}|${projected.toFixed(0)}`;
  const renewalLabel = renewal
    ? `${_MONTHS[new Date(rMs).getUTCMonth()]} ${String(new Date(rMs).getUTCDate()).padStart(2, '0')}`
    : 'unknown';
  return { reportLine, renewalLabel };
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

/**
 * ONE call to /v1/sessions, read for both the session count (already used
 * for the cap-exhausted digest line + attribution-% denominator) and the
 * real per-day minutes (BRO-3240 — pricing was per-session, ~10x off vs
 * Browserbase's actual browser-hour billing). Was two separate concerns
 * fetched from the same endpoint by two functions; merged into one fetch
 * since both parsers read the identical payload.
 * @returns {{sessions:number, minutes:number}|null}
 */
async function fetchBbUsageForDay(apiKey, projectId, dayIso) {
  if (!apiKey || !projectId) return null;
  const json = await _getJson(
    `https://api.browserbase.com/v1/sessions?projectId=${encodeURIComponent(projectId)}`,
    { 'X-BB-API-Key': apiKey },
  );
  if (json == null) return null;
  const sessions = countBbSessionsOnDay(json, dayIso);
  const minutes = sumBbMinutesOnDay(json, dayIso);
  return sessions == null || minutes == null ? null : { sessions, minutes };
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
  bbPayloadCoversDay,
  sumBbMinutesOnDay,
  sbUsageFields,
  parseSbUsage,
  sbCostReportFields,
  parseSdAccount,
  fetchBdZoneCostDay,
  fetchBdBalance,
  fetchBbUsageForDay,
  fetchSbUsage,
  fetchSdAccount,
};

// CLI for workflows: `echo "$SB_USAGE" | node scripts/lib/provider-billing.js --sb-report-line|--sb-renewal`.
// Exits non-zero on unparseable input so the workflow's `|| echo <fallback>` applies.
if (require.main === module) {
  const mode = process.argv[2];
  if (mode !== '--sb-report-line' && mode !== '--sb-renewal') {
    console.error('usage: provider-billing.js --sb-report-line|--sb-renewal  (ScrapingBee /usage JSON on stdin)');
    process.exit(2);
  }
  try {
    const out = sbCostReportFields(JSON.parse(require('fs').readFileSync(0, 'utf8')));
    console.log(mode === '--sb-renewal' ? out.renewalLabel : out.reportLine);
  } catch (err) {
    console.error(`provider-billing.js ${mode}: ${err.message}`);
    process.exit(1);
  }
}
