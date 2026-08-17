#!/usr/bin/env node
// scripts/lib/linear-retry-policy.js — pure retry decisions for the Linear
// transport (scripts/lib/linear-client.js graphql()). No fetch, no fs, no
// timers, no process: every function here is a pure input→output decision so
// the interesting cases (HTTP-date Retry-After, an hour-away reset header, a
// USAGE_LIMIT_EXCEEDED body arriving under a 429) are unit-testable without a
// network stub. Same split this subsystem already uses for linear-dispatch.js
// and linear-cap-policy.js, and CLAUDE.md rule 15 — the tests require() these
// functions rather than restating them.
//
// Task S1-T1 of sprint-plan-notion-linear-cutover.md. Until this landed there
// was ZERO rate-limit handling anywhere in the Linear path, and Sprint 3 puts
// 1,831 issue creations through it.
//
// THE ONE DECISION WORTH READING: 5xx is not retried for mutations.
// A 429 is a rejection *before* execution — nothing was applied, so replaying
// it is always safe. A 5xx (or a socket error, or an AbortSignal timeout) is
// ambiguous: an issue-creating mutation that got a 502 from a proxy may well
// have been committed server-side, and replaying it mints a duplicate into a
// board with no bulk delete. So mutations fail closed on 5xx and the caller
// decides. The right fix for bulk mutation replay is caller-side idempotency,
// not transport retries: Linear's IssueCreateInput accepts a client-supplied
// `id` (verified by live introspection 2026-08-17), so a deterministic UUID
// derived from the Notion pageId makes a replayed create idempotent
// server-side. Sprint 3 does that, and only then may it opt in with
// { retryMutationsOn5xx: true }.

'use strict';

// Never sleep longer than this in one wait. x-ratelimit-requests-reset is an
// epoch-ms timestamp that can sit a full hour out (observed 2026-08-17); a
// transport that honoured it literally would look identical to a hang.
const MAX_DELAY_MS = 60_000;
const DEFAULT_BASE_MS = 500;
// 5 attempts at base 500ms = 0.5 + 1 + 2 + 4 = 7.5s of sleeping worst case,
// before jitter and before any header-driven wait.
const DEFAULT_MAX_ATTEMPTS = 5;

// GraphQL error codes where retrying is pointless or actively harmful. These
// can arrive under a retryable HTTP status, which is the whole reason the
// transport parses a retryable response's body instead of discarding it:
// scripts/lib/linear-issue-create.js's isUsageLimitExceeded() reads
// err.linearErrors[].extensions.code, and a status-only error would make the
// loud free-tier-cap message silently stop firing mid-migration.
const NON_TRANSIENT_CODES = new Set([
  'USAGE_LIMIT_EXCEEDED',
  'AUTHENTICATION_ERROR',
  'FEATURE_NOT_ACCESSIBLE',
  'INVALID_INPUT',
]);

// Fail CLOSED: a document is treated as a mutation unless it is unambiguously
// a read. Linear's GraphQL accepts anonymous query shorthand (`{ viewer { id }
// }`) and named `query(...)`, and every mutation string in linear-client.js
// begins with `mutation` after trimming — but if a future edit produces
// something this does not recognise, the safe answer is "assume it writes".
function isMutation(query) {
  const text = String(query || '').trim();
  if (!text) return true;
  if (/^query\b/.test(text)) return false;
  if (text.startsWith('{')) return false;
  return true;
}

// Pull a header from either a fetch Headers instance or a plain object. The
// existing linear-client tests stub fetch with a bare `{ json }` object and no
// headers at all (tests/unit/linear-client-archived-issue.test.mjs), so this
// must tolerate undefined rather than assume a Headers.
function readHeader(headers, name) {
  if (!headers) return null;
  const lower = String(name).toLowerCase();
  if (typeof headers.get === 'function') {
    const v = headers.get(name);
    return v === undefined ? null : v;
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

function graphqlErrorCodes(body) {
  if (!body || !Array.isArray(body.errors)) return [];
  return body.errors
    .map((e) => (e && e.extensions && e.extensions.code) || null)
    .filter(Boolean);
}

function hasNonTransientError(body) {
  return graphqlErrorCodes(body).some((code) => NON_TRANSIENT_CODES.has(code));
}

// `status` may legitimately be undefined (stubbed fetch responses in the
// existing tests). Every comparison below is POSITIVE for that reason — an
// `!res.ok` test would flip all seven of those tests to the retry path.
function isRetryableStatus(status) {
  return status === 429 || (typeof status === 'number' && status >= 500);
}

/**
 * @param {{status?: number, body?: object|null, mutation?: boolean}} input
 * @returns {{retry: boolean, reason: string}}
 */
function shouldRetry({ status, body = null, mutation = true } = {}) {
  if (!isRetryableStatus(status)) return { retry: false, reason: 'not-retryable-status' };
  if (hasNonTransientError(body)) {
    return { retry: false, reason: `non-transient-code:${graphqlErrorCodes(body).join(',')}` };
  }
  if (status === 429) return { retry: true, reason: 'rate-limited' };
  // 5xx from here down.
  if (mutation) return { retry: false, reason: 'mutation-5xx-ambiguous' };
  return { retry: true, reason: 'server-error-read' };
}

// Transport-level throws: AbortSignal.timeout(30_000) rejects rather than
// returning a response, and so do DNS/socket failures. Same ambiguity as a
// 5xx — the request may have been applied — so callers gate this on
// `mutation` exactly the way they gate 5xx.
function isTransientNetworkError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const code = String(err.code || '');
  if (/^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE)$/.test(code)) return true;
  return /socket hang up|network (?:error|timeout|unreachable)|fetch failed|terminated/i.test(
    String(err.message || '')
  );
}

// Seconds ("120") or an HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT"), per
// RFC 9110. Returns null for anything unparseable so the caller falls back to
// exponential rather than sleeping NaN.
function parseRetryAfter(value, nowMs) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * How long to wait before attempt N+1.
 *
 * Precedence: Retry-After, then Linear's own x-ratelimit-*-reset (epoch ms —
 * verified against a live response 2026-08-17), then exponential backoff.
 * Everything is clamped to MAX_DELAY_MS, so an hour-away reset degrades to a
 * 60s wait instead of a silent hang.
 *
 * @param {number} attempt 1-based attempt that just failed
 * @param {object|Headers|null} headers
 * @param {{baseMs?: number, nowMs?: number, random?: () => number, capMs?: number}} opts
 */
function retryDelayMs(attempt, headers, opts = {}) {
  const baseMs = Number.isFinite(opts.baseMs) ? opts.baseMs : DEFAULT_BASE_MS;
  const capMs = Number.isFinite(opts.capMs) ? opts.capMs : MAX_DELAY_MS;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const random = typeof opts.random === 'function' ? opts.random : Math.random;

  const fromRetryAfter = parseRetryAfter(readHeader(headers, 'retry-after'), nowMs);
  if (fromRetryAfter !== null) return Math.min(capMs, fromRetryAfter);

  for (const name of ['x-ratelimit-requests-reset', 'x-ratelimit-complexity-reset']) {
    const raw = readHeader(headers, name);
    if (raw === null || !/^\d+$/.test(String(raw).trim())) continue;
    const waitMs = Number(String(raw).trim()) - nowMs;
    // A reset already in the past means the window has rolled; fall through to
    // exponential rather than returning 0 and hot-looping.
    if (waitMs > 0) return Math.min(capMs, waitMs);
  }

  // Full-jitter exponential: base * 2^(attempt-1), scaled by [0.5, 1.0]. Half
  // the spread rather than the usual [0, 1] so a retry storm still spreads out
  // but no single attempt collapses to ~0ms.
  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(capMs, Math.round(exp * (0.5 + 0.5 * random())));
}

module.exports = {
  MAX_DELAY_MS,
  DEFAULT_BASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  NON_TRANSIENT_CODES,
  isMutation,
  isRetryableStatus,
  readHeader,
  graphqlErrorCodes,
  hasNonTransientError,
  shouldRetry,
  isTransientNetworkError,
  parseRetryAfter,
  retryDelayMs,
};
