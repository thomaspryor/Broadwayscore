/**
 * gh-api-client — centralized replacement for the fetchJSON()/apiGet()/
 * httpsGet() helper that used to be hand-rolled (near-identically) in a
 * dozen-plus scripts for direct HTTP calls to api.github.com.
 *
 * WHY (task #821 follow-up, BRO-134): gh-call-wrapper.sh (task #821)
 * instruments every `gh` CLI invocation and proved gh CLI usage was NOT the
 * dominant quota burner — only ~70 real API-consuming gh calls were logged
 * in the 20-minute window where the shared token's quota went from
 * thousands to 0. The likely actual burner is direct fetch/https calls to
 * api.github.com, which had NO attribution anywhere: every script wrote its
 * own fetchJSON, so there was no way to tell which one was making the
 * calls. This module is the single implementation every script should
 * require() instead of redefining its own.
 *
 * Every call is logged (via scripts/lib/gh-api-wrapper.sh, so Node- and
 * shell-originated direct API calls share one ledger at
 * ~/.claude/gh-api-call-ledger.log) before the request fires, and reuses
 * the existing fleet-wide cache + rate-limit-headroom guard from
 * scripts/lib/gh-api-cache.js so callers get caching for free by using
 * fetchGitHubJSONCached() instead of a bare fetchGitHubJSON().
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { cachedFetch, hasLowHeadroom, getRateLimitHeadroom } = require('./gh-api-cache.js');

const WRAPPER_PATH = path.join(__dirname, 'gh-api-wrapper.sh');

function defaultCallerName() {
  const entry = require.main && require.main.filename;
  return entry ? path.basename(entry) : 'unknown';
}

/**
 * Best-effort ledger write via gh-api-wrapper.sh. Never throws, never
 * blocks the real request on a logging failure (matches gh-call-wrapper.sh's
 * fail-open philosophy).
 */
function logCall(caller, method, url) {
  try {
    execFileSync(WRAPPER_PATH, ['log', caller, method, url], {
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch {
    /* best-effort — logging must never break the real call */
  }
}

/**
 * Fetch JSON from api.github.com (or any GitHub API host) with auth,
 * standard headers, and ledger logging. Direct replacement for the
 * fetchJSON/apiGet/httpsGet helpers duplicated across scripts.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {object} [opts.headers]
 * @param {string} [opts.token] - defaults to GH_TOKEN/GITHUB_TOKEN env
 * @param {string} [opts.caller] - defaults to the calling script's basename
 * @param {string|Buffer} [opts.body]
 * @returns {Promise<any>} parsed JSON body, or null for a 204
 */
async function fetchGitHubJSON(url, opts = {}) {
  const { method = 'GET', headers = {}, token, caller, body, timeoutMs = 15000 } = opts;
  const callerName = caller || defaultCallerName();
  logCall(callerName, method, url);

  const authToken = token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const finalHeaders = {
    'User-Agent': 'bsc-gh-api-client',
    Accept: 'application/vnd.github+json',
    ...(authToken ? { Authorization: `token ${authToken}` } : {}),
    ...headers,
  };

  // Old duplicated fetchJSON/apiGet implementations all had a ~15s hard
  // timeout on the socket (one hung connection must not hang the whole
  // caller — task #737 hardened audit-workflow-hygiene.js's local copy for
  // exactly this). fetch() has no timeout by default, so replicate it here.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method, headers: finalHeaders, body, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`GitHub API ${method} ${url} -> timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`GitHub API ${method} ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    err.retryAfter = res.headers.get('retry-after');
    throw err;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Same as fetchGitHubJSON, but shares a fleet-wide TTL cache (see
 * scripts/lib/gh-api-cache.js) keyed by `cacheKey` across every concurrent
 * process on the machine. Prefer this over a bare fetchGitHubJSON() for any
 * read-only call that doesn't need per-second freshness.
 *
 * @param {string} cacheKey - stable cache key
 * @param {string} url
 * @param {object} [opts] - same as fetchGitHubJSON
 * @param {number} [ttlMs] - cache TTL override (default: gh-api-cache's 3 min)
 */
async function fetchGitHubJSONCached(cacheKey, url, opts = {}, ttlMs) {
  return cachedFetch(cacheKey, () => fetchGitHubJSON(url, opts), ttlMs ? { ttlMs } : undefined);
}

module.exports = {
  fetchGitHubJSON,
  fetchGitHubJSONCached,
  hasLowHeadroom,
  getRateLimitHeadroom,
  logCall,
};
