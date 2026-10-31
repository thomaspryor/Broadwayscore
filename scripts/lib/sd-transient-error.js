'use strict';
/**
 * Scrapingdog transient-error classification (BRO-6492).
 *
 * Scrapingdog answers some requests with HTTP 400 and a body like
 * "Something went wrong, please try again" (SERP) or "Oops! Something went
 * wrong. You won't be charged for this request" (page/render). These are
 * provider hiccups, not bad requests: re-sending a SERP query that had just
 * 400'd returned 200 three times in a row, and the current ledger held 4,807
 * such SERP 400s (~1 in 25 calls). Failed SD requests are not billed, so one
 * retry is free. The stealth-mode hint shares the same wording but has its
 * own escalation path in scraper.js, so it is NOT transient here.
 */

/** Provider message text from an axios response body (string or JSON object). */
function scrapingdogErrorMessage(body) {
  if (body && typeof body === 'object') {
    if (typeof body.message === 'string') return body.message;
    if (typeof body.error === 'string') return body.error;
    return null;
  }
  return typeof body === 'string' ? body : null;
}

/**
 * @param {{status?: number|null, message?: string|null}} e
 * @returns {boolean} true when one retry is worthwhile
 */
function isTransientScrapingdogError({ status, message } = {}) {
  if (!status) return true;
  if (status >= 500) return true;
  const text = String(message || '');
  if (status === 400 && /something went wrong/i.test(text) && !/stealth_mode\s*=\s*true/i.test(text)) return true;
  return false;
}

/** Status + body from scraper.js's "Scrapingdog HTTP NNN: <body>" error messages. */
function parseScrapingdogHttpError(errorMessage) {
  const m = /Scrapingdog HTTP (\d{3}):?\s*([\s\S]*)$/.exec(String(errorMessage || ''));
  return m ? { status: Number(m[1]), message: m[2] } : null;
}

module.exports = { scrapingdogErrorMessage, isTransientScrapingdogError, parseScrapingdogHttpError };
