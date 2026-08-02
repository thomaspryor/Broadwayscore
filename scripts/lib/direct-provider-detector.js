/**
 * Direct-provider-call detector (Scraping v2 Sprint 2, T12)
 *
 * Finds scripts that construct a raw HTTP call to a scraping provider's
 * content-fetch endpoint instead of routing through fetchPage()/fetchJSON()
 * in scripts/lib/scraper.js. Matches ONLY the content-fetch endpoints (the
 * ones fetchPage() itself calls) — credit/usage/billing endpoints
 * (app.scrapingbee.com/api/v1/usage, api.brightdata.com/zone*,
 * api.scrapingdog.com/account) are a different capability (health/spend
 * checks) and are intentionally not flagged.
 *
 * Pure detection logic lives here so both the CLI (audit-direct-provider-calls.js)
 * and unit tests can call scanSourceForDirectProviderCalls() directly.
 */

const PROVIDER_ENDPOINT_PATTERNS = [
  // ScrapingBee page-fetch base path: /api/v1 (query params, incl. url=, may be
  // built separately via axios `params` or multi-line string concat, so we
  // match the base path and explicitly exclude the two non-content-fetch
  // siblings: /api/v1/usage (credit check) and /api/v1/store/google (SERP).
  { provider: 'scrapingbee', regex: /https?:\/\/app\.scrapingbee\.com\/api\/v1(?!\/usage)(?!\/store)\b/gi },
  // Bright Data page-fetch: POST https://api.brightdata.com/request (zone+url in body).
  // Distinct from the billing endpoints (/zone, /zone/cost, /customer/balance)
  // and the SERP endpoints (/serp/req, /serp/get_result).
  { provider: 'brightdata', regex: /https?:\/\/api\.brightdata\.com\/request\b/gi },
  // Scrapingdog page-fetch: /scrape. Distinct from /account (credit check).
  { provider: 'scrapingdog', regex: /https?:\/\/api\.scrapingdog\.com\/scrape\b/gi },
  // Browserbase session create/list share the SAME path (/v1/sessions) —
  // unlike the other 3 providers, there is no distinct billing subpath to
  // exclude via regex. The read-only session-list callers (browserbase-live-usage.js,
  // provider-billing.js) and the canonical chokepoint itself
  // (browserbase-session.js) are carved out via the file-level allowlist
  // instead (task #752).
  //
  // Two Browserbase patterns, because the host and the path carry different signal.
  //
  // newspapers-browserbase-login.js built its session-create URL as
  // `${API}${endpoint}` off a `const API = 'https://api.browserbase.com/v1'`, so
  // the original /v1/sessions-only regex scored ZERO hits on a file that really
  // does POST /sessions — the gate's "a new session-create call site fails CI"
  // guarantee was vacuous for any caller that split the URL. Matching only up to
  // `/v1` would still miss the next split one level up
  // (`const HOST = 'https://api.browserbase.com'` + `${HOST}/v1/sessions`).
  //
  // So: api.browserbase.com matches on the HOST alone — that host is API-only, so
  // naming it at all must be justified in the allowlist, at any split point.
  // www.browserbase.com requires the /v1 path, because www also serves the human
  // dashboard: test-paywalled-access.js console.logs
  // `https://www.browserbase.com/sessions/${id}` as a debug link while correctly
  // creating its session through createBbSession(). Host-only matching on www
  // would flag that correct file, and allowlisting it would blind the gate to a
  // future REAL direct call in the same file.
  //
  // connect.browserbase.com (the CDP websocket every migrated caller dials AFTER
  // createBbSession returns) is matched by neither — it creates no session, and
  // flagging it would fire on all 9 legitimate callers.
  { provider: 'browserbase', regex: /https?:\/\/api\.browserbase\.com/gi },
  { provider: 'browserbase', regex: /https?:\/\/www\.browserbase\.com\/v1\b/gi },
];

/**
 * Scan a single file's source text for direct-provider content-fetch calls.
 * @param {string} source
 * @returns {Array<{provider: string, line: number, snippet: string}>}
 */
function scanSourceForDirectProviderCalls(source) {
  const hits = [];
  const lines = source.split('\n');
  for (const { provider, regex } of PROVIDER_ENDPOINT_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(source)) !== null) {
      const upTo = source.slice(0, match.index);
      const lineNum = upTo.split('\n').length;
      hits.push({
        provider,
        line: lineNum,
        snippet: (lines[lineNum - 1] || '').trim().slice(0, 160),
      });
    }
  }
  // Stable order: by line number, then provider name.
  hits.sort((a, b) => a.line - b.line || a.provider.localeCompare(b.provider));
  return hits;
}

module.exports = { scanSourceForDirectProviderCalls, PROVIDER_ENDPOINT_PATTERNS };
