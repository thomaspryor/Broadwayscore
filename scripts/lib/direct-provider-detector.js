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
 * SEPARATELY (task #1005, sibling of #998), the SERP endpoints — ScrapingBee
 * store/google, Bright Data serp/req+get_result, Scrapingdog google/ — get
 * their own `*-serp` provider patterns below. These were excluded from the
 * content-fetch patterns above on purpose (SERP is a different capability),
 * but that exclusion left NO detector at all for a script that calls the
 * SERP endpoint directly and bypasses url-discovery.js's serpQuery()/
 * serpNewsQuery()/serpImagesQuery() — exactly the scraper-spend-ledger-bypass
 * bug class task #998 fixed for discover-outlet-reviews-serp.js. A caller
 * legitimately needing the raw provider response (bake-off/diagnostic tools)
 * goes in scripts/config/direct-provider-calls-allowlist.json, same as the
 * content-fetch carve-outs.
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

  // BARE-HOST CONSTANTS — the same split-URL defeat, generalized to the other
  // three providers (task #752 follow-up). The patterns above are path-aware on
  // purpose: they must NOT match the billing/SERP siblings (/api/v1/usage,
  // /api/v1/store/google, /zone/cost, /account). But that path-awareness is
  // exactly what a caller defeats by keeping the host in its own constant:
  //
  //   const SB = 'https://app.scrapingbee.com';
  //   fetch(SB + '/api/v1/?api_key=' + k + '&url=' + u);   // 0 hits before this
  //
  // Verified 2026-08-02: this escaped for scrapingbee, brightdata AND scrapingdog.
  // Matching only a COMPLETE quoted string that ends at the host catches the
  // split form without touching the path-based exclusions — a literal with any
  // path (including the exempt billing ones) simply doesn't match these.
  // Zero files in scripts/ or src/ trip these today, so this is prospective.
  { provider: 'scrapingbee', regex: /['"`]https?:\/\/app\.scrapingbee\.com['"`]/gi },
  { provider: 'brightdata', regex: /['"`]https?:\/\/api\.brightdata\.com['"`]/gi },
  { provider: 'scrapingdog', regex: /['"`]https?:\/\/api\.scrapingdog\.com['"`]/gi },
  { provider: 'browserbase', regex: /['"`]https?:\/\/www\.browserbase\.com['"`]/gi },

  // KNOWN GAP (ship-check finding, task #1005): the bare-host patterns above
  // label a split-URL SERP call (`const SB = '...scrapingbee.com'; SB +
  // '/api/v1/store/google'`) as generic 'scrapingbee', not 'scrapingbee-serp'
  // — same collapse for BD/SD. If a file is ALSO already baselined for
  // generic 'scrapingbee' (a bare-host content-fetch split), this specific
  // combination could re-escape computeNewViolators' provider diff. Same
  // residual class the bare-host patterns already accept as prospective
  // (zero files trip them today); a path-aware bare-host rewrite would close
  // it fully but wasn't warranted for this pass — revisit if it's ever
  // actually exploited.
  // SERP endpoints (task #1005) — deliberately the exact siblings excluded
  // above. url-discovery.js is the canonical chokepoint (allowlisted in
  // scripts/config/direct-provider-calls-allowlist.json) — a hit anywhere
  // else means a script is spending SERP credits outside the ledger.
  { provider: 'scrapingbee-serp', regex: /https?:\/\/app\.scrapingbee\.com\/api\/v1\/store\/google\b/gi },
  { provider: 'brightdata-serp', regex: /https?:\/\/api\.brightdata\.com\/serp\/(?:req|get_result)\b/gi },
  { provider: 'scrapingdog-serp', regex: /https?:\/\/api\.scrapingdog\.com\/google\/?\b/gi },
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

/**
 * Diff a fresh scanRepo() result against the frozen baseline, provider-aware
 * (task #1005). A file already baselined for one provider must still trip on
 * a NEW, different provider — file-level-only diffing let a file's first
 * violation blanket-forgive every future provider on that same file, which
 * is exactly the "sibling call, same file, different endpoint" shape both
 * task #998 (discover-outlet-reviews-serp.js) and #1005 are about.
 * @param {Array<{file: string, providers: string[]}>} violators - current scanRepo() output
 * @param {Object} baselineFiles - baseline.files (file -> {providers, cronReachable})
 * @returns {Array<{file: string, providers: string[]}>} violators with only the NOT-yet-baselined providers, entries with zero new providers dropped
 */
function computeNewViolators(violators, baselineFiles) {
  return violators
    .map(v => {
      const baselinedProviders = new Set(baselineFiles[v.file]?.providers || []);
      const newProviders = v.providers.filter(p => !baselinedProviders.has(p));
      return newProviders.length ? { ...v, providers: newProviders } : null;
    })
    .filter(Boolean);
}

module.exports = { scanSourceForDirectProviderCalls, PROVIDER_ENDPOINT_PATTERNS, computeNewViolators };
