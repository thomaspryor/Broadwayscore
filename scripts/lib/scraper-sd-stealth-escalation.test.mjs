// S1-T2 (Scraping cost v3, card 3b1637c5): fetchWithScrapingdog must
// auto-escalate to stealth_mode when SD's own 400 body says "You can try
// enabling Stealth Mode using stealth_mode=true" — the live parity retest
// (2026-08-03, 30 URLs) found this exact signature on ~1/3 of
// didtheylikeit.com's SD failures, and every one succeeded on a
// stealth_mode retry. Before this fix, production treated the 400 as
// terminal and fell straight through to Bright Data (~17x the cost).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

// Redirect telemetry away from the real committed ledger — synthetic mocked
// calls are not real spend and must not pollute
// data/audit/scraper-spend-ledger.jsonl (see scraper-sb-latch.test.mjs).
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(os.tmpdir(), `scraper-spend-ledger-test-${process.pid}.jsonl`);

// Isolate from the REAL ScrapingDog daily circuit breaker (card #1252):
// fetchWithScrapingdog() calls consultScrapingdog() with no env override, so
// it reads process.env / the real data/audit/sd-circuit-breaker.json. When the
// live account trips its daily ceiling (frequent per the BSC Daily "Credits:
// ScrapingDog" alerts), every assertion in this file failed with 0 HTTP calls
// made — the mock never got exercised because the breaker short-circuited
// fetchWithScrapingdog before it reached https.get. This test exercises the
// stealth-mode escalation logic, not the breaker, so disable it here the same
// way brightdata-caps.test.mjs isolates BD's breaker via BD_BREAKER_STATE_PATH
// (task #1312). Verified green + gate re-tested 2026-08-17 (task #1312 close-out).
process.env.SD_CAPS_DISABLED = '1';

const STEALTH_400_BODY = JSON.stringify({
  message: "Oops! Something went wrong. You won't be charged for this request. You can try enabling Stealth Mode using stealth_mode=true. If the issue continues, feel free to email us at info@scrapingdog.com.",
});

function mockScrapingdog(responder) {
  const original = https.get;
  const calls = []; // only /scrape attempts — the fire-and-forget /account
  // quota preflight also flows through this same mock and must not count as
  // a scrape attempt in assertions.
  https.get = (apiUrl, options, callback) => {
    const isScrapeCall = apiUrl.includes('/scrape?');
    if (isScrapeCall) calls.push(apiUrl);
    const req = new EventEmitter();
    const res = new EventEmitter();
    const { statusCode, body } = isScrapeCall
      ? responder(apiUrl, calls.length)
      : { statusCode: 200, body: '{}' }; // /account preflight: malformed-but-parseable, quota check no-ops
    res.statusCode = statusCode;
    process.nextTick(() => {
      callback(res);
      process.nextTick(() => {
        res.emit('data', Buffer.from(body));
        res.emit('end');
      });
    });
    return req;
  };
  return { restore: () => { https.get = original; }, calls };
}

function freshScraper() {
  delete require.cache[require.resolve('./scraper.js')];
  return require('./scraper.js');
}

test('fetchWithScrapingdog auto-escalates to stealth_mode on the specific 400 signature and succeeds', async () => {
  const mock = mockScrapingdog((apiUrl) => {
    if (/stealth_mode=true/.test(apiUrl)) return { statusCode: 200, body: '<html>'.padEnd(2000, 'x') + '</html>' };
    return { statusCode: 400, body: STEALTH_400_BODY };
  });
  const originalKey = process.env.SCRAPINGDOG_API_KEY;
  process.env.SCRAPINGDOG_API_KEY = 'test-key';
  try {
    const scraper = freshScraper();
    const result = await scraper.fetchWithScrapingdog('https://didtheylikeit.com/shows/some-show/');
    assert.ok(result, 'escalated call succeeded');
    assert.equal(result.source, 'scrapingdog');
    assert.equal(mock.calls.length, 2, 'exactly two HTTP calls: plain (400) then stealth_mode (200) — no third attempt, no BD fallback needed');
    assert.ok(!/stealth_mode=true/.test(mock.calls[0]), 'first call is plain (no stealth_mode param)');
    assert.ok(/stealth_mode=true/.test(mock.calls[1]), 'second call carries stealth_mode=true');
  } finally {
    mock.restore();
    if (originalKey === undefined) delete process.env.SCRAPINGDOG_API_KEY;
    else process.env.SCRAPINGDOG_API_KEY = originalKey;
  }
});

test('fetchWithScrapingdog does not escalate (or loop) when already in stealth_mode', async () => {
  const mock = mockScrapingdog(() => ({ statusCode: 400, body: STEALTH_400_BODY }));
  const originalKey = process.env.SCRAPINGDOG_API_KEY;
  process.env.SCRAPINGDOG_API_KEY = 'test-key';
  try {
    const scraper = freshScraper();
    const result = await scraper.fetchWithScrapingdog('https://didtheylikeit.com/shows/some-show/', { stealthMode: true });
    assert.equal(result, null, 'gives up — no infinite recursion');
    assert.equal(mock.calls.length, 1, 'exactly one attempt (MAX_ATTEMPTS caps 400 retries at 1, no escalation loop since already stealth)');
  } finally {
    mock.restore();
    if (originalKey === undefined) delete process.env.SCRAPINGDOG_API_KEY;
    else process.env.SCRAPINGDOG_API_KEY = originalKey;
  }
});

test('fetchJSON-style caller (throwOn400:true) does not get double-escalated when the stealth retry ALSO 400s (ship-check finding)', async () => {
  // Reproduces fetchJSON's own SD block: throwOn400:true on the plain call.
  // Before the fix, a stealth attempt that also 400'd would rethrow
  // sdStatus=400 up through the auto-escalation, making fetchJSON's catch
  // block think the PLAIN tier just failed and fire a THIRD (redundant)
  // stealth_mode attempt — ~40 credits on one URL instead of ~11.
  const mock = mockScrapingdog(() => ({ statusCode: 400, body: STEALTH_400_BODY }));
  const originalKey = process.env.SCRAPINGDOG_API_KEY;
  process.env.SCRAPINGDOG_API_KEY = 'test-key';
  try {
    const scraper = freshScraper();
    const result = await scraper.fetchWithScrapingdog('https://didtheylikeit.com/shows/some-show/', { throwOn400: true });
    assert.equal(result, null, 'resolves to null (no throw) once the internal stealth retry also fails — the outer throwOn400 contract is only for the FIRST caller-visible attempt, not internal retries');
    assert.equal(mock.calls.length, 2, 'exactly two attempts: plain (400) then one stealth_mode retry (also 400) — no third attempt');
  } finally {
    mock.restore();
    if (originalKey === undefined) delete process.env.SCRAPINGDOG_API_KEY;
    else process.env.SCRAPINGDOG_API_KEY = originalKey;
  }
});

test('fetchWithScrapingdog does not escalate on an unrelated 400 (structural "URL does not exist")', async () => {
  const mock = mockScrapingdog(() => ({ statusCode: 400, body: JSON.stringify({ message: 'This URL does not exist or the url is wrong.' }) }));
  const originalKey = process.env.SCRAPINGDOG_API_KEY;
  process.env.SCRAPINGDOG_API_KEY = 'test-key';
  try {
    const scraper = freshScraper();
    const result = await scraper.fetchWithScrapingdog('https://theatre.reviews/reviews-roundup/nonexistent-reviews/');
    assert.equal(result, null, 'structural 404-style 400 stays terminal — retrying wastes latency on a page that will never exist');
    assert.equal(mock.calls.length, 1, 'no stealth_mode escalation attempted');
  } finally {
    mock.restore();
    if (originalKey === undefined) delete process.env.SCRAPINGDOG_API_KEY;
    else process.env.SCRAPINGDOG_API_KEY = originalKey;
  }
});
