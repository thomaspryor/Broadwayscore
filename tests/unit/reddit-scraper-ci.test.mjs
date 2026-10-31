// tests/unit/reddit-scraper-ci.test.mjs — BRO-546.
//
// Reddit 403s direct requests from GitHub Actions runner IPs even though the
// same fetch() call succeeds locally (different network reputation, not a
// TLS-fingerprint issue — see scripts/lib/reddit-api.js's fetchRedditDirect
// comment). This simulates exactly that CI shape end-to-end through the
// PUBLIC entrypoint the pipeline actually calls (searchSubreddit ->
// fetchWithFallback), not an individual provider in isolation like the
// sibling reddit-api-*.test.mjs files: direct access 403s, there are no
// OAuth creds (reddit.com/prefs/apps app creation has been broken for the
// owner for months — see memory/feedback_reddit_app_creation_broken.md),
// and Bright Data is unavailable (robots.txt-gated since 2026-07-05) — the
// exact secret shape update-reddit-sentiment.yml's CI job runs with once
// REDDIT_CLIENT_ID/SECRET are absent. Only the proxy tier (Scrapingdog, kept
// funded per CLAUDE.md reference_paywall_subscriptions_status.md) is left,
// and it must carry the request end-to-end without the caller ever seeing
// the 403.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

// Mock Scrapingdog endpoint — same shape as tests/unit/reddit-api-scrapingdog.test.mjs.
const sdServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  assert.ok(u.searchParams.get('api_key'), 'api_key must be sent');
  res.writeHead(200);
  res.end(JSON.stringify({
    data: {
      children: [{ kind: 't3', data: { id: 'ci1', title: 'Hamilton discussion thread' } }],
      after: null,
    },
  }));
});

let sdBaseUrl;
let originalFetch;

before(async () => {
  await new Promise((resolve) => sdServer.listen(0, '127.0.0.1', resolve));
  sdBaseUrl = `http://127.0.0.1:${sdServer.address().port}/scrape`;
  originalFetch = globalThis.fetch;
});

after(() => {
  sdServer.close();
  globalThis.fetch = originalFetch;
});

// Stubs global fetch so any direct reddit.com call 403s (the GitHub Actions
// IP block) while leaving every other host (the mock Scrapingdog server)
// untouched — fetchViaScrapingDog uses the `https`/`http` modules, not
// fetch(), so it's unaffected by this stub.
function stub403Direct() {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('reddit.com')) {
      return { status: 403, text: async () => 'blocked' };
    }
    throw new Error(`unexpected fetch() call in CI-shape test: ${target}`);
  };
}

function loadRedditApi() {
  const require = createRequire(import.meta.url);
  delete require.cache[require.resolve('../../scripts/lib/reddit-api.js')];
  return require('../../scripts/lib/reddit-api.js');
}

// Env shape mirrors update-reddit-sentiment.yml's CI job: no REDDIT_CLIENT_ID/
// SECRET (OAuth app creation broken for the owner), no BRIGHTDATA_TOKEN
// (permanently robots.txt-gated for reddit.com), SCRAPINGDOG_API_KEY set.
function setCiEnv() {
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
  delete process.env.BRIGHTDATA_TOKEN;
  delete process.env.SCRAPINGBEE_API_KEY;
  process.env.SCRAPINGDOG_API_KEY = 'ci-test-key';
  process.env.SCRAPINGDOG_BASE_URL = sdBaseUrl;
}

function clearCiEnv() {
  delete process.env.SCRAPINGDOG_API_KEY;
  delete process.env.SCRAPINGDOG_BASE_URL;
}

test('searchSubreddit retrieves data in CI shape despite Reddit 403ing direct access', async () => {
  stub403Direct();
  setCiEnv();
  try {
    const { searchSubreddit, resetFallbackState, getStats } = loadRedditApi();
    resetFallbackState();

    const result = await searchSubreddit('Broadway', 'Hamilton', { limit: 5 });

    assert.equal(result.data.children.length, 1);
    assert.equal(result.data.children[0].data.id, 'ci1');
    const stats = getStats();
    assert.equal(stats.scrapingDog, 1, 'the proxy tier must have carried the request');
    assert.equal(stats.redditDirect, 0, 'direct access must not have succeeded (it 403s in CI)');
  } finally {
    clearCiEnv();
  }
});

test('fetchWithFallback authenticates and returns data with only the CI-available proxy tier', async () => {
  stub403Direct();
  setCiEnv();
  try {
    const { fetchWithFallback, resetFallbackState } = loadRedditApi();
    resetFallbackState();

    const url = 'https://www.reddit.com/r/Broadway/comments/abc123.json?limit=500&depth=10&raw_json=1';
    const result = await fetchWithFallback(url);

    assert.equal(result.data.children[0].data.id, 'ci1');
  } finally {
    clearCiEnv();
  }
});

test('fetchWithFallback surfaces an actionable error when no proxy is configured in CI', async () => {
  stub403Direct();
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
  delete process.env.BRIGHTDATA_TOKEN;
  delete process.env.SCRAPINGBEE_API_KEY;
  delete process.env.SCRAPINGDOG_API_KEY;
  delete process.env.SCRAPINGDOG_BASE_URL;
  try {
    const { fetchWithFallback, resetFallbackState } = loadRedditApi();
    resetFallbackState();

    await assert.rejects(
      () => fetchWithFallback('https://www.reddit.com/r/Broadway/search.json?q=Hamilton'),
      /Reddit blocked and all proxies unavailable/
    );
  } finally {
    clearCiEnv();
  }
});
