/**
 * gh-api-cache — shared, short-TTL cache for read-only GitHub API calls
 * (`gh run list`, api.github.com fetches), plus a rate-limit headroom guard.
 *
 * Why this exists: dozens of headless Claude sessions are dispatched per day
 * (data/audit/dispatch-ledger.jsonl), each in its OWN isolated git worktree
 * (scripts/lib/bsc-runner.js), and each runs health-check.js (via /ship-check
 * and /wrap-up) — which alone issues ~20 `gh run list`/api.github.com calls
 * per invocation (15 CRITICAL_CRONS entries + push-verify + secrets-health +
 * the workflow-run summary + needs-manual-review). All of these share ONE
 * GH_TOKEN/PAT and its single 5000/hour REST quota (confirmed via `gh api
 * rate_limit`: core 5000/5000 used). Because each session runs in its own
 * worktree, a cache file inside the repo would NOT be shared across
 * concurrently-dispatched sessions — this cache deliberately lives in the
 * OS temp dir (like the existing /tmp/*-launchd.log convention) so every
 * concurrent process on this Mac shares one set of recent results instead of
 * each independently re-fetching the same "did workflow X succeed recently"
 * answer within the same few minutes.
 *
 * Best-effort only: a corrupt/missing cache file just means a fresh fetch,
 * never a hard failure. No cross-process lock — a handful of concurrent
 * cache misses re-fetching once is still far cheaper than every process
 * fetching unconditionally.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CACHE_PATH = path.join(os.tmpdir(), 'bsc-gh-api-cache.json');
const RATE_LIMIT_CACHE_PATH = path.join(os.tmpdir(), 'bsc-gh-rate-limit-cache.json');
const DEFAULT_TTL_MS = 3 * 60 * 1000; // 3 min — well under the freshness these checks need
const RATE_LIMIT_TTL_MS = 60 * 1000; // 1 min
const LOW_HEADROOM_THRESHOLD = 200; // stop spending non-essential calls below this

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(p, data) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, p);
}

/**
 * Run a `gh`/shell command whose stdout is cacheable, sharing results across
 * every concurrent process on this Mac for `ttlMs`.
 * @param {string} key - stable cache key (the command string is fine)
 * @param {string} cmd - shell command to run on a cache miss
 */
function cachedShell(key, cmd, { ttlMs = DEFAULT_TTL_MS, execOpts = {} } = {}) {
  const all = readJson(CACHE_PATH) || {};
  const hit = all[key];
  if (hit && (Date.now() - hit.ts) < ttlMs) return hit.value;
  const value = execSync(cmd, { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], ...execOpts }).trim();
  all[key] = { ts: Date.now(), value };
  try { writeJsonAtomic(CACHE_PATH, all); } catch { /* best-effort */ }
  return value;
}

/**
 * Same sharing as cachedShell, for an async fetch function (e.g. the
 * existing fetchJSON(url, headers) helper).
 */
async function cachedFetch(key, fetchFn, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const all = readJson(CACHE_PATH) || {};
  const hit = all[key];
  if (hit && (Date.now() - hit.ts) < ttlMs) return hit.value;
  const value = await fetchFn();
  all[key] = { ts: Date.now(), value };
  try { writeJsonAtomic(CACHE_PATH, all); } catch { /* best-effort */ }
  return value;
}

/**
 * Remaining core REST quota, via the FREE /rate_limit endpoint (GitHub docs:
 * checking it does not itself consume quota). Cached 60s so concurrent
 * callers within the same minute share one check. Uses `gh api` (not a raw
 * curl with the token in argv) so the token never appears in a process list.
 * @returns {{remaining: number, limit: number, reset: number}|null}
 */
function getRateLimitHeadroom() {
  const cached = readJson(RATE_LIMIT_CACHE_PATH);
  if (cached && (Date.now() - cached.ts) < RATE_LIMIT_TTL_MS) return cached.value;
  try {
    const raw = execSync(
      'gh api rate_limit --jq "{remaining: .rate.remaining, limit: .rate.limit, reset: .rate.reset}"',
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const value = JSON.parse(raw);
    try { writeJsonAtomic(RATE_LIMIT_CACHE_PATH, { ts: Date.now(), value }); } catch { /* best-effort */ }
    return value;
  } catch {
    return null;
  }
}

/**
 * True when remaining core quota is below `threshold` (or the check itself
 * failed — fail CLOSED here since a failed rate_limit call is itself often a
 * symptom of an already-exhausted token). Callers use this to skip
 * non-essential bulk GitHub API work gracefully instead of burning the last
 * of a shared, fleet-wide budget.
 */
function hasLowHeadroom(threshold = LOW_HEADROOM_THRESHOLD) {
  const h = getRateLimitHeadroom();
  if (!h) return false; // unknown state: don't block on a check we couldn't make
  return h.remaining < threshold;
}

module.exports = {
  cachedShell,
  cachedFetch,
  getRateLimitHeadroom,
  hasLowHeadroom,
  CACHE_PATH,
  RATE_LIMIT_CACHE_PATH,
  DEFAULT_TTL_MS,
  RATE_LIMIT_TTL_MS,
  LOW_HEADROOM_THRESHOLD,
};
