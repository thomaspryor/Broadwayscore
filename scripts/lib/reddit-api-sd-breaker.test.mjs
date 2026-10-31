// BRO-4215: Reddit's Scrapingdog stealth tier failed HTTP 500 on ~19,090 of
// ~19,500 calls in one week, and every failure was booked in the spend ledger
// at 10 credits although Scrapingdog does not bill failures. These tests pin
// the consecutive-failure breaker and the zero-credit failure rows against the
// real reddit-api.js functions (CLAUDE.md §15), using a local mock SD server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let server;
let hits = 0;
let respondOk = false;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reddit-sd-breaker-'));
const ledgerPath = path.join(tmp, 'ledger.jsonl');
let api;

before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    if (respondOk) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"data":{"children":[]}}');
    } else {
      res.writeHead(500);
      res.end("Oops! Something went wrong. You won't be charged for this request");
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.SCRAPINGDOG_BASE_URL = `http://127.0.0.1:${server.address().port}/scrape`;
  process.env.SCRAPINGDOG_API_KEY = 'test-key';
  process.env.SCRAPER_SPEND_LEDGER_PATH = ledgerPath;
  // Keep the daily SD breaker (scrapingdog-caps.js) from touching real state.
  process.env.SD_CAPS_DISABLED = '1';
  api = require('./reddit-api.js');
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('shouldAttemptScrapingdog: closed below threshold, open at it, probes every Nth skip', () => {
  const { shouldAttemptScrapingdog } = require('./reddit-api.js');
  const opts = { threshold: 5, probeEvery: 50 };
  assert.equal(shouldAttemptScrapingdog(0, 0, opts), true);
  assert.equal(shouldAttemptScrapingdog(4, 0, opts), true);
  assert.equal(shouldAttemptScrapingdog(5, 0, opts), false);
  assert.equal(shouldAttemptScrapingdog(5, 1, opts), false);
  assert.equal(shouldAttemptScrapingdog(5, 49, opts), false);
  assert.equal(shouldAttemptScrapingdog(5, 50, opts), true, 'probe');
  assert.equal(shouldAttemptScrapingdog(9, 100, opts), true, 'probe');
});

test('fetchViaScrapingDog stops calling SD after 5 straight failures, probes, and recovers', async () => {
  api.resetFallbackState();
  hits = 0;
  respondOk = false;
  const url = 'https://www.reddit.com/r/Broadway/search.json?q=x';
  for (let i = 0; i < 60; i++) {
    await assert.rejects(api.fetchViaScrapingDog(url));
  }
  // 5 real failures, then 49 skips, then the 50th skip is a probe (1 hit), then more skips.
  assert.equal(hits, 6, `expected 5 failures + 1 probe to reach SD, got ${hits}`);

  // SD recovers: calls keep being skipped until the next probe, which succeeds and closes the breaker.
  respondOk = true;
  let ok = 0;
  for (let i = 0; i < 60 && ok === 0; i++) {
    try { await api.fetchViaScrapingDog(url); ok++; } catch (_) { /* still open */ }
  }
  assert.equal(ok, 1, 'a probe should succeed once SD recovers');
  hits = 0;
  await api.fetchViaScrapingDog(url);
  assert.equal(hits, 1, 'breaker closed after a successful probe');
});

test('failed SD responses are ledgered at 0 credits, successes at the tier price', () => {
  const rows = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((r) => r.provider === 'scrapingdog' && r.fn !== 'day-cap');
  const failed = rows.filter((r) => !r.success);
  const succeeded = rows.filter((r) => r.success);
  assert.ok(failed.length >= 5, 'failure rows recorded');
  assert.ok(failed.every((r) => r.credits === 0), `failure rows must bill 0, got ${[...new Set(failed.map((r) => r.credits))]}`);
  assert.ok(succeeded.length >= 1 && succeeded.every((r) => r.credits > 0), 'success rows bill the tier price');
});
