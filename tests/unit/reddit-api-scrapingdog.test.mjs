import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

// Mock Scrapingdog endpoint — behavior keyed off the target url param
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const target = u.searchParams.get('url') || '';
  assert.ok(u.searchParams.get('api_key'), 'api_key must be sent');
  assert.equal(u.searchParams.get('dynamic'), 'false', 'reddit JSON needs no JS rendering');

  if (target.includes('good')) {
    res.writeHead(200);
    res.end(JSON.stringify({ data: { children: [{ kind: 't3', data: { id: 'abc' } }] } }));
  } else if (target.includes('wrapped')) {
    res.writeHead(200);
    res.end('<html><body>{"data":{"children":[]}}</body></html>');
  } else if (target.includes('garbage')) {
    res.writeHead(200);
    res.end('Access denied, no json here');
  } else if (target.includes('unauthorized')) {
    res.writeHead(401);
    res.end('{"message":"missing credits"}');
  } else {
    res.writeHead(500);
    res.end('boom');
  }
});

let baseUrl;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/scrape`;
  process.env.SCRAPINGDOG_BASE_URL = baseUrl;
  process.env.SCRAPINGDOG_API_KEY = 'test-key';
});
after(() => {
  server.close();
  delete process.env.SCRAPINGDOG_BASE_URL;
  delete process.env.SCRAPINGDOG_API_KEY;
});

function load() {
  const require = createRequire(import.meta.url);
  // Fresh module instance so SCRAPINGDOG_BASE_URL (read at load) picks up the mock
  delete require.cache[require.resolve('../../scripts/lib/reddit-api.js')];
  return require('../../scripts/lib/reddit-api.js');
}

test('fetchViaScrapingDog parses a JSON reddit payload', async () => {
  const { fetchViaScrapingDog, getStats, resetFallbackState } = load();
  resetFallbackState();
  const result = await fetchViaScrapingDog('https://old.reddit.com/r/broadway/search.json?q=good');
  assert.equal(result.data.children[0].data.id, 'abc');
  assert.equal(getStats().scrapingDog, 1, 'stats should count the request');
});

test('fetchViaScrapingDog extracts JSON from an HTML wrapper', async () => {
  const { fetchViaScrapingDog } = load();
  const result = await fetchViaScrapingDog('https://old.reddit.com/wrapped.json');
  assert.deepEqual(result.data.children, []);
});

test('fetchViaScrapingDog rejects on non-JSON body', async () => {
  const { fetchViaScrapingDog } = load();
  await assert.rejects(
    () => fetchViaScrapingDog('https://old.reddit.com/garbage.json'),
    /not JSON/
  );
});

test('fetchViaScrapingDog rejects on 401 with actionable message', async () => {
  const { fetchViaScrapingDog } = load();
  await assert.rejects(
    () => fetchViaScrapingDog('https://old.reddit.com/unauthorized.json'),
    /Scrapingdog 401.*SCRAPINGDOG_API_KEY/s
  );
});

test('fetchViaScrapingDog rejects when no key is configured', async () => {
  const { fetchViaScrapingDog } = load();
  const saved = process.env.SCRAPINGDOG_API_KEY;
  delete process.env.SCRAPINGDOG_API_KEY;
  try {
    await assert.rejects(() => fetchViaScrapingDog('https://old.reddit.com/x.json'), /not set/);
  } finally {
    process.env.SCRAPINGDOG_API_KEY = saved;
  }
});
