import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

// Isolate from the real SD circuit breaker (BRO-364 added a consultScrapingdog()
// check to fetchViaScrapingDog) — same pattern as
// scraper-sd-stealth-escalation.test.mjs (#1312): these tests must not
// depend on data/audit/sd-circuit-breaker.json's live tripped/untripped state.
process.env.SD_CAPS_DISABLED = '1';

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
  } else if (target.includes('browser-pre')) {
    // Mirrors Scrapingdog stealth tier (run 29876609047): a real-browser
    // render wraps raw JSON in <pre> with HTML-escaped entities.
    res.writeHead(200);
    res.end('<html><head><meta charset="utf-8"></head><body><pre>{&quot;data&quot;:{&quot;children&quot;:[{&quot;kind&quot;:&quot;t3&quot;,&quot;data&quot;:{&quot;id&quot;:&quot;pre1&quot;,&quot;title&quot;:&quot;Tom &amp; Jerry &lt;live&gt;&quot;}}]}}</pre></body></html>');
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
// BRO-364 wired recordSdCall into scrapingDogRequest, so every fetchViaScrapingDog
// call in this file now writes a ledger row — redirect ALL of them (not just the
// dedicated ledger-attribution tests below) to a scratch path for the whole file,
// or every test run would append real-looking rows to the committed
// data/audit/scraper-spend-ledger.jsonl (caught: a first pass here polluted 40+
// lines into that file on a single `node --test` run).
const defaultLedgerPath = path.join(os.tmpdir(), `reddit-sd-ledger-default-${process.pid}.jsonl`);
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/scrape`;
  process.env.SCRAPINGDOG_BASE_URL = baseUrl;
  process.env.SCRAPINGDOG_API_KEY = 'test-key';
  process.env.SCRAPER_SPEND_LEDGER_PATH = defaultLedgerPath;
});
after(() => {
  server.close();
  delete process.env.SCRAPINGDOG_BASE_URL;
  delete process.env.SCRAPINGDOG_API_KEY;
  delete process.env.SCRAPER_SPEND_LEDGER_PATH;
  try { fs.unlinkSync(defaultLedgerPath); } catch { /* cleanup */ }
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

test('fetchViaScrapingDog bills the ledger on a 401 (full tier cost — mirrors scraper.js, unlike SB\'s zero-on-auth-failure)', async () => {
  const ledgerPath = path.join(os.tmpdir(), `reddit-sd-ledger-test-401-${process.pid}.jsonl`);
  try { fs.unlinkSync(ledgerPath); } catch { /* fine if absent */ }
  const savedLedgerPath = process.env.SCRAPER_SPEND_LEDGER_PATH;
  process.env.SCRAPER_SPEND_LEDGER_PATH = ledgerPath;
  try {
    const { fetchViaScrapingDog, resetFallbackState } = load();
    resetFallbackState();
    await assert.rejects(() => fetchViaScrapingDog('https://old.reddit.com/unauthorized.json'));
    const rows = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].success, false);
    assert.equal(rows[0].status, 401);
    assert.equal(rows[0].credits, 1, 'plain-tier 401 still bills 1 credit — SD served a response, unlike SB which zero-rates 401/402');
  } finally {
    if (savedLedgerPath) process.env.SCRAPER_SPEND_LEDGER_PATH = savedLedgerPath;
    else delete process.env.SCRAPER_SPEND_LEDGER_PATH;
    try { fs.unlinkSync(ledgerPath); } catch { /* cleanup */ }
  }
});

test('fetchViaScrapingDog bills 0 credits on a connection-level error', async () => {
  const ledgerPath = path.join(os.tmpdir(), `reddit-sd-ledger-test-conn-err-${process.pid}.jsonl`);
  try { fs.unlinkSync(ledgerPath); } catch { /* fine if absent */ }
  const savedLedgerPath = process.env.SCRAPER_SPEND_LEDGER_PATH;
  const savedBaseUrl = process.env.SCRAPINGDOG_BASE_URL;
  process.env.SCRAPER_SPEND_LEDGER_PATH = ledgerPath;
  // Port 1 is reserved and nothing listens there — client.get() fails at the
  // connection level (ECONNREFUSED), never reaching the 'end' handler.
  process.env.SCRAPINGDOG_BASE_URL = 'http://127.0.0.1:1/scrape';
  try {
    const { fetchViaScrapingDog, resetFallbackState } = load();
    resetFallbackState();
    await assert.rejects(() => fetchViaScrapingDog('https://old.reddit.com/r/broadway/search.json?q=good'));
    const rows = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].success, false);
    assert.equal(rows[0].status, 'error');
    assert.equal(rows[0].credits, 0, 'a connection that never reached SD must not bill');
  } finally {
    if (savedLedgerPath) process.env.SCRAPER_SPEND_LEDGER_PATH = savedLedgerPath;
    else delete process.env.SCRAPER_SPEND_LEDGER_PATH;
    if (savedBaseUrl) process.env.SCRAPINGDOG_BASE_URL = savedBaseUrl;
    else delete process.env.SCRAPINGDOG_BASE_URL;
    try { fs.unlinkSync(ledgerPath); } catch { /* cleanup */ }
  }
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

test('fetchViaScrapingDog parses browser-rendered <pre> JSON with escaped entities', async () => {
  const { fetchViaScrapingDog, resetFallbackState } = load();
  resetFallbackState();
  const result = await fetchViaScrapingDog('https://www.reddit.com/r/broadway/browser-pre.json');
  assert.equal(result.data.children[0].data.id, 'pre1');
  assert.equal(result.data.children[0].data.title, 'Tom & Jerry <live>');
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

// ---------- fetchViaScrapingDog ledger attribution + breaker gate (BRO-364) ----------
//
// Prior to BRO-364, scrapingDogRequest() never called recordSdCall — Reddit's
// SD credit spend (up to 10cr/call once escalated) was invisible to
// check-provider-spend.js's daily attribution, and fetchViaScrapingDog never
// consulted the daily circuit breaker, so a tripped breaker never throttled
// Reddit's SD traffic the way it does scraper.js's fetchWithScrapingdog.

test('fetchViaScrapingDog writes one ledger row with the plain-tier credit cost', async () => {
  const ledgerPath = path.join(os.tmpdir(), `reddit-sd-ledger-test-${process.pid}.jsonl`);
  try { fs.unlinkSync(ledgerPath); } catch { /* fine if absent */ }
  const savedLedgerPath = process.env.SCRAPER_SPEND_LEDGER_PATH;
  process.env.SCRAPER_SPEND_LEDGER_PATH = ledgerPath;
  try {
    const { fetchViaScrapingDog, resetFallbackState } = load();
    resetFallbackState();
    await fetchViaScrapingDog('https://old.reddit.com/r/broadway/search.json?q=good');
    const rows = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(rows.length, 1, 'exactly one ledger row per SD call');
    assert.equal(rows[0].provider, 'scrapingdog');
    assert.equal(rows[0].success, true);
    assert.equal(rows[0].credits, 1, 'plain tier bills 1 credit');
  } finally {
    if (savedLedgerPath) process.env.SCRAPER_SPEND_LEDGER_PATH = savedLedgerPath;
    else delete process.env.SCRAPER_SPEND_LEDGER_PATH;
    try { fs.unlinkSync(ledgerPath); } catch { /* cleanup */ }
  }
});

test('fetchViaScrapingDog ledger rows bill 10 credits once escalated to premium/stealth', async () => {
  const ledgerPath = path.join(os.tmpdir(), `reddit-sd-ledger-test-esc-${process.pid}.jsonl`);
  try { fs.unlinkSync(ledgerPath); } catch { /* fine if absent */ }
  const savedLedgerPath = process.env.SCRAPER_SPEND_LEDGER_PATH;
  process.env.SCRAPER_SPEND_LEDGER_PATH = ledgerPath;
  try {
    const { fetchViaScrapingDog, resetFallbackState } = load();
    resetFallbackState();
    await fetchViaScrapingDog('https://old.reddit.com/r/broadway/needs-stealth.json');
    const rows = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    // plain 400 (1cr) + premium 400 (10cr) + stealth 200 (10cr)
    assert.deepEqual(rows.map(r => r.credits), [1, 10, 10]);
    assert.deepEqual(rows.map(r => r.success), [false, false, true]);
  } finally {
    if (savedLedgerPath) process.env.SCRAPER_SPEND_LEDGER_PATH = savedLedgerPath;
    else delete process.env.SCRAPER_SPEND_LEDGER_PATH;
    try { fs.unlinkSync(ledgerPath); } catch { /* cleanup */ }
  }
});

test('fetchViaScrapingDog rejects (falls through to caller) when the daily breaker is tripped', async () => {
  const savedCapsDisabled = process.env.SD_CAPS_DISABLED;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-breaker-test-'));
  const statePath = path.join(stateDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ day: new Date().toISOString().slice(0, 10), trippedAt: Date.now(), dayCredits: 999999, ceiling: 1 }));
  delete process.env.SD_CAPS_DISABLED;
  process.env.SD_BREAKER_STATE_PATH = statePath;
  try {
    const { fetchViaScrapingDog, getStats, resetFallbackState } = load();
    resetFallbackState();
    await assert.rejects(
      () => fetchViaScrapingDog('https://old.reddit.com/r/broadway/search.json?q=good'),
      /breaker/,
    );
    assert.equal(getStats().scrapingDog, 0, 'a breaker-blocked call must never reach the SD API');
  } finally {
    delete process.env.SD_BREAKER_STATE_PATH;
    if (savedCapsDisabled) process.env.SD_CAPS_DISABLED = savedCapsDisabled;
    fs.rmSync(stateDir, { recursive: true, force: true });
    // scrapingdog-caps.js caches breaker state for 60s at module scope (not
    // per env/path) — reset it so this test's tripped state can't leak into
    // any other test file sharing this node:test process.
    const require = createRequire(import.meta.url);
    require('../../scripts/lib/scrapingdog-caps.js')._resetForTests();
  }
});

// ---------- fetchViaScrapingBee ledger attribution (S0-T4) ----------
//
// fetchViaScrapingBee's target host is hardcoded (app.scrapingbee.com — no
// SCRAPINGDOG_BASE_URL-style override), so it can't be redirected to the mock
// HTTP server above. Instead, monkeypatch the shared 'https' module's get()
// — the same object instance reddit-api.js's own `require('https')` resolves
// to — to simulate a response without a real network call.

function withMockedHttpsGet(statusCode, body, fn) {
  const original = https.get;
  https.get = (_url, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    const req = new EventEmitter();
    process.nextTick(() => {
      cb(res);
      res.emit('data', Buffer.from(body));
      res.emit('end');
    });
    return req;
  };
  return fn().finally(() => { https.get = original; });
}

test('fetchViaScrapingBee writes exactly one ledger row (premium_proxy, 10 credits) on success', async () => {
  const ledgerPath = path.join(os.tmpdir(), `reddit-sb-ledger-test-${process.pid}.jsonl`);
  try { fs.unlinkSync(ledgerPath); } catch { /* fine if absent */ }
  const savedLedgerPath = process.env.SCRAPER_SPEND_LEDGER_PATH;
  process.env.SCRAPER_SPEND_LEDGER_PATH = ledgerPath;
  process.env.SCRAPINGBEE_API_KEY = 'sb-test-key';
  try {
    const { fetchViaScrapingBee } = load();
    await withMockedHttpsGet(200, JSON.stringify({ data: { children: [] } }), () => fetchViaScrapingBee('https://old.reddit.com/r/broadway/good.json'));
    const rows = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(rows.length, 1, 'exactly one ledger row per SB fallback call');
    assert.equal(rows[0].provider, 'scrapingbee');
    assert.equal(rows[0].success, true);
    assert.equal(rows[0].credits, 10, 'premium_proxy=true bills 10 credits');
  } finally {
    if (savedLedgerPath) process.env.SCRAPER_SPEND_LEDGER_PATH = savedLedgerPath;
    else delete process.env.SCRAPER_SPEND_LEDGER_PATH;
    delete process.env.SCRAPINGBEE_API_KEY;
    try { fs.unlinkSync(ledgerPath); } catch { /* cleanup */ }
  }
});

test('fetchViaScrapingBee writes credits:0 on a 401 (billing/auth failure never charges)', async () => {
  const ledgerPath = path.join(os.tmpdir(), `reddit-sb-ledger-test-401-${process.pid}.jsonl`);
  try { fs.unlinkSync(ledgerPath); } catch { /* fine if absent */ }
  const savedLedgerPath = process.env.SCRAPER_SPEND_LEDGER_PATH;
  process.env.SCRAPER_SPEND_LEDGER_PATH = ledgerPath;
  process.env.SCRAPINGBEE_API_KEY = 'sb-test-key';
  try {
    const { fetchViaScrapingBee } = load();
    await assert.rejects(
      () => withMockedHttpsGet(401, JSON.stringify({ message: 'Invalid api key' }), () => fetchViaScrapingBee('https://old.reddit.com/r/broadway/good.json')),
    );
    const rows = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].success, false);
    assert.equal(rows[0].credits, 0);
  } finally {
    if (savedLedgerPath) process.env.SCRAPER_SPEND_LEDGER_PATH = savedLedgerPath;
    else delete process.env.SCRAPER_SPEND_LEDGER_PATH;
    delete process.env.SCRAPINGBEE_API_KEY;
    try { fs.unlinkSync(ledgerPath); } catch { /* cleanup */ }
  }
});
