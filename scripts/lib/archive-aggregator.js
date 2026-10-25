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

module.exports = { fetchWithBrightData };
