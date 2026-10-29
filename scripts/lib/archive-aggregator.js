'use strict';
/**
 * Bright Data tier of archive-aggregator-pages.yml (BRO-3486).
 *
 * The old tier sent BRIGHTDATA_TOKEN (an account-level Bearer API key) as the
 * raw-proxy-protocol password to brd.superproxy.io:33335, which expects the
 * zone's own password, so every call got 407. This now delegates to
 * scraper.js fetchWithBrightData (REST /request + Bearer), the single choke
 * point that applies the daily circuit breaker, per-run budget and spend
 * telemetry. Zone comes from BRIGHTDATA_ZONE (set by the workflow).
 */

/** fetchBd(url, opts) defaults to scraper.js fetchWithBrightData; injectable for tests. */
async function fetchWithBrightData(url, fetchBd) {
  const doFetch = fetchBd || require('./scraper').fetchWithBrightData;
  const res = await doFetch(url, { fallbackFrom: 'scrapingbee' });
  if (!res) throw new Error('Bright Data returned no content (failed, capped, or token missing)');
  if (res.brdError) throw new Error(`Bright Data error header: ${res.brdError}`);
  if (typeof res.content !== 'string' || res.content.trim() === '') {
    throw new Error('Bright Data returned empty body');
  }
  return res.content;
}

/**
 * Fetch one aggregator page as HTML through the shared fallback chain
 * (BRO-3606 item 1: replaces the workflow's inline axios ScrapingBee call).
 * Archived pages are parsed as markup later, so a markdown result is refused.
 * fetchPageFn defaults to scraper.js fetchPage; injectable for tests.
 * @returns {Promise<{html: string, method: string}>}
 */
async function fetchArchivePage(url, fetchPageFn) {
  const doFetch = fetchPageFn || require('./scraper').fetchPage;
  const res = await doFetch(url, { wait: 5000, skipVerify: true });
  if (!res || typeof res.content !== 'string' || res.content.trim() === '') {
    throw new Error('fetchPage returned no content');
  }
  if (res.format !== 'html') {
    throw new Error(`fetchPage returned '${res.format}', archive needs html`);
  }
  return { html: res.content, method: res.source || 'fetchpage' };
}

module.exports = { fetchWithBrightData, fetchArchivePage };
