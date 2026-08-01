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
