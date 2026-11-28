'use strict';
// Shared transient-vs-auth classification and a single retry for affiliate
// provider fetches (Impact, PostHog). Used by the daily health monitor
// (check-affiliate-health.js) and the weekly report (affiliate-stats.js via
// affiliate-report.js). Moved here from check-affiliate-health.js in BRO-8220:
// the 2026-11-22 Impact 503 blanked the weekly report's context box because
// the report's baseline fetch had no retry, while the monitor's did.

const RETRY_DELAY_MS = 2000; // after a timeout/abort
// A provider-side 5xx/429 needs longer than a timeout retry to clear: the
// 2026-10-09 PostHog 503 paged CRITICAL from a single attempt (BRO-4945).
const HTTP_RETRY_DELAY_MS = 15000;

function isAbortError(err) {
  return Boolean(err && (err.name === 'AbortError' || /aborted/i.test(err.message || '')));
}

// Server-side/rate-limit statuses only. 4xx auth errors (401/403) are a real
// fault (revoked key) and must surface on the first attempt. Same status rule
// as posthog-adhoc-query.js isTransientError.
function isTransientHttpError(err) {
  const m = /\bHTTP (\d{3})\b/.exec((err && err.message) || '');
  if (!m) return false;
  const status = Number(m[1]);
  return status >= 500 || status === 429 || status === 408;
}

// Network-level failures (undici "fetch failed", resets, DNS blips) clear on
// a retry just like a 5xx, and are never a credentials fault (BRO-8220).
function isTransientNetworkError(err) {
  return /\bfetch failed\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test((err && err.message) || '');
}

function isTransientFetchError(err) {
  return isAbortError(err) || isTransientHttpError(err) || isTransientNetworkError(err);
}

// The only failures the owner can fix by re-authorizing: the provider
// rejected the credentials (HTTP 401/403, or Impact's 200-with-error body
// naming an auth problem), or they are not configured at all.
function isAuthFetchError(err) {
  return /\bHTTP 40[13]\b|credentials missing|unauthori[sz]ed|authenticat|invalid (api )?(key|token|credentials)/i.test((err && err.message) || '');
}

// One retry, for timeouts/aborts, network blips and provider 5xx/429/408
// only. An auth or other 4xx error is a real fault and retrying it just burns
// the remaining budget. Logs on retry even when the second attempt succeeds,
// so a flaky-not-dead provider stays visible in the run's step log.
async function fetchWithOneRetry(fn, label, {
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logPrefix = '[affiliate-health]',
} = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientFetchError(err)) throw err;
    const delayMs = isAbortError(err) ? RETRY_DELAY_MS : HTTP_RETRY_DELAY_MS;
    console.warn(`${logPrefix} ${label || 'fetch'}: transient error (${err.message}), retrying once in ${delayMs / 1000}s`);
    await sleep(delayMs);
    return fn();
  }
}

module.exports = {
  RETRY_DELAY_MS,
  HTTP_RETRY_DELAY_MS,
  isAbortError,
  isTransientHttpError,
  isTransientNetworkError,
  isTransientFetchError,
  isAuthFetchError,
  fetchWithOneRetry,
};
