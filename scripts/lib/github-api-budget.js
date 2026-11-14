#!/usr/bin/env node
/**
 * github-api-budget — check the remaining GitHub REST quota before an
 * OPTIONAL batch of API calls, and skip the batch when the quota is low.
 *
 * WHY (BRO-4654): every workflow in this repo that authenticates with the
 * default GITHUB_TOKEN draws on ONE installation quota (1,000 requests/hour
 * per repository). On 2026-10-05 00:00-01:00 UTC a landing burst spent it and
 * every GITHUB_TOKEN API call in the repo got HTTP 403 "API rate limit
 * exceeded for installation" for the rest of the hour, stranding landings.
 * The biggest spender was an advisory audit (audit-workflow-hygiene.js rule
 * (f), ~256 calls per scan) that ran twice in every dispatched land.yml run.
 * Advisory work like that must yield to the calls that move code.
 *
 * GET /rate_limit is free (it does not count against the quota) and still
 * answers once the quota is spent, so checking first costs nothing.
 *
 * This is the CI-side guard (fetch + an explicit token, no gh CLI, no cache
 * file). gh-api-cache.js's hasLowHeadroom() is the Mac-session guard: it
 * shares one cached `gh api rate_limit` answer across local processes.
 *
 * Library:
 *   parseRateLimit(json)                          → {remaining, limit, used, reset} | null
 *   decideBudget({quota, cost, reserve, nowSec})  → {ok, reason}
 *   readRateLimit({token, fetchImpl, timeoutMs})  → quota | null (never throws)
 *   checkBudget({cost, reserve, token, fetchImpl}) → {ok, reason, quota}
 *
 * CLI (for workflow shell steps):
 *   node scripts/lib/github-api-budget.js --cost 260 [--reserve 300]
 *   exit 0 → enough quota, go ahead; exit 1 → skip the optional calls;
 *   exit 2 → bad arguments. Prints one `[gh-api-budget] …` line. Token from
 *   GH_TOKEN or GITHUB_TOKEN.
 *
 * Unknown quota (no token, network error, malformed body) → ok:false. An
 * optional batch skipped by mistake costs one advisory signal; an optional
 * batch run against a spent quota costs the landings that run next.
 */
'use strict';

// Calls left for required work (land, deploy, push fallbacks) after the
// optional batch spends its share: 300 of the 1,000-call GITHUB_TOKEN hour.
const DEFAULT_RESERVE = 300;

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Accepts the full /rate_limit body (`resources.core`, or the legacy `rate`) or a core object. */
function parseRateLimit(json) {
  if (!json || typeof json !== 'object') return null;
  const core = (json.resources && json.resources.core) || json.rate || json;
  const remaining = toInt(core.remaining);
  const limit = toInt(core.limit);
  if (remaining === null || limit === null) return null;
  return { remaining, limit, used: toInt(core.used), reset: toInt(core.reset) };
}

/** Pure: may an optional batch of `cost` calls run now and still leave `reserve` calls? */
function decideBudget({ quota, cost = 1, reserve = DEFAULT_RESERVE, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!quota || typeof quota.remaining !== 'number') {
    return { ok: false, reason: 'quota unknown (rate_limit unreadable), skipping optional calls' };
  }
  const resetIn = typeof quota.reset === 'number' ? Math.max(0, quota.reset - nowSec) : null;
  const state = `${quota.remaining}/${quota.limit} left${resetIn === null ? '' : `, resets in ${Math.ceil(resetIn / 60)}m`}`;
  const ask = `need ${cost} + reserve ${reserve}`;
  if (quota.remaining >= Math.max(0, cost) + Math.max(0, reserve)) return { ok: true, reason: `${state}; ${ask}` };
  return { ok: false, reason: `low quota: ${state}; ${ask}, skipping optional calls` };
}

async function readRateLimit({ token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (!token || typeof fetchImpl !== 'function') return null;
  try {
    const res = await fetchImpl('https://api.github.com/rate_limit', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'broadwayscore-gh-api-budget' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res || !res.ok) return null;
    return parseRateLimit(await res.json());
  } catch {
    return null;
  }
}

async function checkBudget({ cost = 1, reserve = DEFAULT_RESERVE, token, fetchImpl, nowSec } = {}) {
  const quota = await readRateLimit({ token, fetchImpl });
  return { ...decideBudget({ quota, cost, reserve, nowSec }), quota };
}

function parseArgs(argv) {
  const out = { cost: 1, reserve: DEFAULT_RESERVE };
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].indexOf('=');
    const key = eq === -1 ? argv[i] : argv[i].slice(0, eq);
    if (key !== '--cost' && key !== '--reserve') throw new Error(`unknown argument ${argv[i]}`);
    const raw = eq === -1 ? argv[++i] : argv[i].slice(eq + 1);
    const n = toInt(raw);
    if (n === null || n < 0) throw new Error(`${key} needs a non-negative number`);
    out[key.slice(2)] = n;
  }
  return out;
}

module.exports = { DEFAULT_RESERVE, parseRateLimit, decideBudget, readRateLimit, checkBudget, parseArgs };

if (require.main === module) {
  (async () => {
    let args;
    try {
      args = parseArgs(process.argv.slice(2));
    } catch (e) {
      console.error(`[gh-api-budget] ${e.message}`);
      process.exit(2);
    }
    const r = await checkBudget(args);
    console.log(`[gh-api-budget] ${r.ok ? 'OK' : 'SKIP'}: ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  })();
}
