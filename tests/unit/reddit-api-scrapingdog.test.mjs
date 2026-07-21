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
  } else if (target.includes('needs-stealth')) {
    // Mirrors real Scrapingdog behavior on reddit (2026-07-05): plain AND
    // premium tiers 400 with a stealth hint; only stealth_mode=true succeeds.
    if (u.searchParams.get('stealth_mode') === 'true') {
      res.writeHead(200);
      res.end(JSON.stringify({ data: { children: [], tier: 'stealth' } }));
    } else {
      res.writeHead(400);
      res.end('Oops! Something went wrong. You can try enabling Stealth Mode using stealth_mode=true.');
    }
  } else if (target.includes('empty-on-plain')) {
    // Mirrors real Scrapingdog behavior on reddit (2026-07-21): the plain
    // tier 200s with an EMPTY body (target blocked the datacenter proxy);
    // premium succeeds. Empty-200 must escalate like the 400 stealth hint.
    if (u.searchParams.get('premium') === 'true' || u.searchParams.get('stealth_mode') === 'true') {
      res.writeHead(200);
      res.end(JSON.stringify({ data: { children: [], tier: 'premium' } }));
    } else {
      res.writeHead(200);
      res.end('');
    }
  } else if (target.includes('generic-400')) {
    // Mirrors real Scrapingdog behavior on reddit (2026-07-21, run
    // 29876347401): premium tier 400s with a GENERIC error (no stealth
    // hint); only stealth succeeds. Any 400 must escalate the ladder.
    if (u.searchParams.get('stealth_mode') === 'true') {
      res.writeHead(200);
      res.end(JSON.stringify({ data: { children: [], tier: 'stealth' } }));
    } else {
      res.writeHead(400);
      res.end('{"message":"Something went wrong please try again!","status":400,"success":false}');
    }
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

test('fetchViaScrapingDog escalates plain -> premium -> stealth on 400 stealth hint, then latches', async () => {
  const { fetchViaScrapingDog, getStats, resetFallbackState } = load();
  resetFallbackState();
  const result = await fetchViaScrapingDog('https://old.reddit.com/r/broadway/needs-stealth.json');
  assert.equal(result.data.tier, 'stealth');
  // plain 400 + premium 400 + stealth 200 = 3 requests
  assert.equal(getStats().scrapingDog, 3, 'escalation should cost 2 extra probes');

  // Tier is latched: next request goes straight to stealth (1 request)
  const again = await fetchViaScrapingDog('https://old.reddit.com/r/broadway/needs-stealth.json');
  assert.equal(again.data.tier, 'stealth');
  assert.equal(getStats().scrapingDog, 4, 'latched tier should not re-probe lower tiers');
});

test('fetchViaScrapingDog escalates on empty-200 body (reddit block signature)', async () => {
  const { fetchViaScrapingDog, getStats, resetFallbackState } = load();
  resetFallbackState();
  const result = await fetchViaScrapingDog('https://www.reddit.com/r/broadway/empty-on-plain.json');
  assert.equal(result.data.tier, 'premium');
  // plain empty-200 + premium 200 = 2 requests
  assert.equal(getStats().scrapingDog, 2, 'empty-200 should escalate to premium');
});

test('fetchViaScrapingDog escalates on generic 400 without stealth hint', async () => {
  const { fetchViaScrapingDog, getStats, resetFallbackState } = load();
  resetFallbackState();
  const result = await fetchViaScrapingDog('https://www.reddit.com/r/broadway/generic-400.json');
  assert.equal(result.data.tier, 'stealth');
  // plain 400 + premium 400 + stealth 200 = 3 requests, one-time toll per
  // run — sdTierIndex latches so later calls skip straight to stealth
  assert.equal(getStats().scrapingDog, 3, 'generic 400 should walk the full ladder once');
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
