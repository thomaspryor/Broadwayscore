'use strict';
/**
 * Bright Data tier of archive-aggregator-pages.yml (BRO-3486).
 *
 * The old tier sent BRIGHTDATA_TOKEN (an account-level Bearer API key) as the
 * raw-proxy-protocol password to brd.superproxy.io:33335, which expects the
 * zone's own password, so every call got 407. The REST /request endpoint takes
 * the Bearer token directly (same call as scripts/lib/scraper.js), needs no
 * customer id and no extra secret.
 */

const BD_REQUEST_URL = 'https://api.brightdata.com/request';
const DEFAULT_ZONE = 'web_unlocker2';

function resolveZone(zoneName) {
  return zoneName && String(zoneName).trim() !== '' ? String(zoneName).trim() : DEFAULT_ZONE;
}

/** Pure: the axios request config for one Bright Data REST fetch. */
function buildBrightDataRequest(url, token, zoneName) {
  if (!token || String(token).trim() === '') throw new Error('BRIGHTDATA_TOKEN missing');
  return {
    url: BD_REQUEST_URL,
    body: { zone: resolveZone(zoneName), url, format: 'raw' },
    config: {
      headers: {
        Authorization: `Bearer ${String(token).trim()}`,
        'Content-Type': 'application/json',
      },
      timeout: 90000,
      responseType: 'text',
      transformResponse: [(d) => d],
    },
  };
}

/** post(url, body, config) defaults to axios.post; injectable for tests. */
async function fetchWithBrightData(url, token, zoneName, post) {
  const req = buildBrightDataRequest(url, token, zoneName);
  const doPost = post || require('axios').post;
  const res = await doPost(req.url, req.body, req.config);
  if (typeof res.data !== 'string' || res.data.trim() === '') {
    throw new Error('Bright Data returned empty body');
  }
  return res.data;
}

module.exports = { BD_REQUEST_URL, DEFAULT_ZONE, resolveZone, buildBrightDataRequest, fetchWithBrightData };
