import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

// Mock Reddit OAuth: token endpoint + oauth.reddit.com data endpoint
let tokenRequests = 0;
let expiredHits = 0;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/v1/access_token')) {
    tokenRequests++;
    assert.equal(req.method, 'POST');
    assert.ok(req.headers.authorization?.startsWith('Basic '), 'client creds must be Basic auth');
    assert.ok(req.headers['user-agent'], 'reddit requires a User-Agent');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: `tok-${tokenRequests}`, token_type: 'bearer', expires_in: 3600 }));
    return;
  }
  if (req.url.startsWith('/r/Broadway/expired.json')) {
    expiredHits++;
    if (expiredHits === 1) { res.writeHead(401); res.end('{"error":401}'); }
    else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { children: [{ kind: 't3', data: { id: 'refreshed' } }] } }));
    }
    return;
  }
  if (req.url.startsWith('/r/Broadway/always401.json')) {
    res.writeHead(401);
    res.end('{"error":401}');
    return;
  }
  if (req.url.startsWith('/r/Broadway/search.json')) {
    if (/^Bearer tok-\d+$/.test(req.headers.authorization || '')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { children: [{ kind: 't3', data: { id: 'oauth1' } }] } }));
    } else {
      res.writeHead(401);
      res.end('{"error":401}');
    }
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

let base;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.REDDIT_TOKEN_URL = `${base}/api/v1/access_token`;
  process.env.REDDIT_OAUTH_BASE = base;
  process.env.REDDIT_CLIENT_ID = 'test-client';
  process.env.REDDIT_CLIENT_SECRET = 'test-secret';
  // Never leak to real proxies if the OAuth path regresses
  for (const k of ['SCRAPINGBEE_API_KEY', 'SCRAPINGDOG_API_KEY', 'BRIGHTDATA_TOKEN']) delete process.env[k];
});
after(() => {
  server.close();
  for (const k of ['REDDIT_TOKEN_URL', 'REDDIT_OAUTH_BASE', 'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET']) delete process.env[k];
});

function load() {
  const require = createRequire(import.meta.url);
  delete require.cache[require.resolve('../../scripts/lib/reddit-api.js')];
  return require('../../scripts/lib/reddit-api.js');
}

test('fetchViaOauth mints a token and rewrites the host to oauth base', async () => {
  const { fetchViaOauth, resetFallbackState } = load();
  resetFallbackState();
  const result = await fetchViaOauth('https://www.reddit.com/r/Broadway/search.json?q=Hamilton&raw_json=1');
  assert.equal(result.data.children[0].data.id, 'oauth1');
  assert.equal(tokenRequests, 1, 'one token mint');
});

test('fetchViaOauth reuses the cached token across calls', async () => {
  const { fetchViaOauth, resetFallbackState } = load();
  resetFallbackState();
  const before = tokenRequests;
  await fetchViaOauth('https://www.reddit.com/r/Broadway/search.json?q=a');
  await fetchViaOauth('https://www.reddit.com/r/Broadway/search.json?q=b');
  assert.equal(tokenRequests, before + 1, 'second call reuses cached token');
});

test('fetchViaOauth refreshes the token once on a data-endpoint 401', async () => {
  const { fetchViaOauth, resetFallbackState } = load();
  resetFallbackState();
  const before = tokenRequests;
  const result = await fetchViaOauth('https://www.reddit.com/r/Broadway/expired.json');
  assert.equal(result.data.children[0].data.id, 'refreshed');
  assert.equal(tokenRequests, before + 2, 'initial mint + one refresh mint');
});

test('fetchViaOauth latches oauthDown when a fresh token also 401s', async () => {
  const { fetchViaOauth, resetFallbackState, _oauthState } = load();
  resetFallbackState();
  await assert.rejects(
    () => fetchViaOauth('https://www.reddit.com/r/Broadway/always401.json'),
    /app blocked|suspended/
  );
  assert.equal(_oauthState().oauthDown, true, 'latch must trip so the fleet stops re-minting');
  assert.equal(_oauthState().hasCreds, false, 'hasOauthCreds must go false after latch');
});

test('searchSubreddit routes through OAuth when creds are set', async () => {
  const { searchSubreddit, resetFallbackState, getStats } = load();
  resetFallbackState();
  const listing = await searchSubreddit('Broadway', 'Hamilton', { limit: 5 });
  assert.equal(listing.data.children.length, 1);
  assert.equal(listing.data.children[0].data.id, 'oauth1');
  assert.equal(getStats().scrapingDog, 0, 'no proxy calls when OAuth works');
  assert.equal(getStats().scrapingBee, 0);
});
