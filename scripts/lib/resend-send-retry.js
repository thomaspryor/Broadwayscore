'use strict';
// BRO-6157: the 2026-10-23 opening digest never arrived because ONE Resend
// request timed out (15s) and the script gave up. Retrying a send is only safe
// when Resend dedupes it, so every attempt carries the same Idempotency-Key
// (a timed-out attempt may already have been accepted). Retry only transient
// failures: timeouts/socket errors, HTTP 429, HTTP 5xx. Other 4xx fail at once.

const DEFAULT_DELAYS_MS = [2000, 8000, 20000];

function isRetryableSendError(err) {
  const msg = String((err && err.message) || err || '');
  const m = /^HTTP (\d{3})\b/.exec(msg);
  if (m) {
    const code = Number(m[1]);
    return code === 429 || code >= 500;
  }
  return /timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up/i.test(msg);
}

// Key is stable across attempts and across same-day workflow re-runs for the same
// recipient+subject, so a manual re-dispatch cannot double-send either (Resend
// holds keys 24h). dayKey is the ET calendar date. payloadHash keeps a deliberate
// same-day re-send with changed content from 409-ing on a reused key.
function buildIdempotencyKey(prefix, dayKey, recipient, payloadHash = '') {
  return `${prefix}/${dayKey}/${String(recipient).toLowerCase()}${payloadHash ? `/${payloadHash}` : ''}`.slice(0, 256);
}

async function sendWithRetry(attempt, { delaysMs = DEFAULT_DELAYS_MS, sleep = (ms) => new Promise(r => setTimeout(r, ms)), log = console.error } = {}) {
  let lastErr;
  for (let i = 0; i <= delaysMs.length; i++) {
    try {
      return await attempt(i);
    } catch (err) {
      lastErr = err;
      if (i === delaysMs.length || !isRetryableSendError(err)) throw err;
      log(`[resend-retry] attempt ${i + 1} failed (${err.message}); retrying in ${delaysMs[i]}ms`);
      await sleep(delaysMs[i]);
    }
  }
  throw lastErr;
}

module.exports = { isRetryableSendError, buildIdempotencyKey, sendWithRetry, DEFAULT_DELAYS_MS };
