'use strict';

/**
 * BRO-3712: retry a Gmail API call through Google's per-user rate limit.
 *
 * finance-ingest.yml runs its receipts and DMARC jobs side by side on the same
 * mailbox. The first run after the token renewal caught up five weeks of mail
 * and got "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units
 * per minute per user'" (run 38343920837). That limit resets within a minute,
 * so waiting and retrying is the fix, not failing the day's ingest.
 */

const { readHeader, parseRetryAfter, isTransientNetworkError } = require('./linear-retry-policy');

const RETRY_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError']);

/** Whether a googleapis (gaxios) error is a rate limit or a transient Google error. */
function isRetryableGmailError(err) {
  if (!err) return false;
  // gaxios 7 copies the cause's string code (e.g. 'ECONNRESET') onto err.code,
  // so the HTTP status comes from .status / response.status first.
  const status = Number(err.status || (err.response && err.response.status) || (Number.isFinite(Number(err.code)) ? err.code : 0));
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  const reasons = ((err.errors || (err.response && err.response.data && err.response.data.error && err.response.data.error.errors)) || [])
    .map((e) => e && e.reason);
  if (status === 403 && reasons.some((r) => RETRY_REASONS.has(r))) return true;
  // Every Gmail call wrapped here is a read, so a dropped socket is safe to retry.
  if (isTransientNetworkError(err)) return true;
  // A daily-quota message also matches; it cannot recover in time, so it costs
  // about two minutes of waits before throwing, which is bounded.
  return /quota exceeded|rate limit/i.test(String(err.message || ''));
}

/** Milliseconds to wait before attempt n (0-based), honouring Retry-After when Google sends one. */
function retryDelayMs(err, attempt, { baseMs = 2000, maxMs = 60000, random = Math.random, nowMs = Date.now() } = {}) {
  // gaxios 7 hands back a fetch Headers; older versions a plain object. readHeader takes both.
  const after = parseRetryAfter(readHeader(err && err.response && err.response.headers, 'retry-after'), nowMs);
  if (after !== null && after > 0) return Math.min(after, maxMs);
  const backoff = Math.min(baseMs * 2 ** attempt, maxMs);
  return Math.round(backoff / 2 + random() * (backoff / 2));
}

/**
 * Runs fn, retrying rate-limit and 5xx errors with backoff. Other errors (an
 * invalid_grant, a 404) throw at once.
 */
async function withGmailRetry(fn, { maxAttempts = 7, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.error, ...delayOpts } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt + 1 >= maxAttempts || !isRetryableGmailError(err)) throw err;
      const ms = retryDelayMs(err, attempt, delayOpts);
      const status = err.status || (err.response && err.response.status) || err.code || '?';
      log(`gmail rate limit or transient error (${status}; attempt ${attempt + 1}/${maxAttempts}); waiting ${Math.round(ms / 1000)}s`);
      await sleep(ms);
    }
  }
}

module.exports = { withGmailRetry, isRetryableGmailError, retryDelayMs };
