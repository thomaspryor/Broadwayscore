// S1-T5/S1-T6 (Scraping cost v3, card 3b1637c5): ScrapingBee's proactive
// /usage credit check (checkScrapingBeeCredits, scraper.js:189) was only ever
// invoked by scripts that opted in explicitly — most don't — so sbCreditsLow
// stayed false all process even with the account genuinely exhausted at the
// monthly-plan level (2026-08-03 cost investigation: 86 SB attempts at 0%
// success). The fix makes fetchWithScrapingBee() and url-discovery's
// _serpViaScrapingBee() each fire the check once, fire-and-forget, on their
// first call (mirroring the Scrapingdog _checkScrapingdogQuotaOnce pattern).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

// Redirect telemetry away from the real committed ledger — these are
// synthetic mocked calls, not real spend, and must not pollute
// data/audit/scraper-spend-ledger.jsonl (bit us once: a first pass at this
// test file left 17 fake rows in the shared cost-accounting ledger).
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(os.tmpdir(), `scraper-spend-ledger-test-${process.pid}.jsonl`);

function mockLowCreditsUsageEndpoint() {
  const original = https.get;
  let calls = 0;
  https.get = (url, options, callback) => {
    calls++;
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.statusCode = 200;
    process.nextTick(() => {
      callback(res);
      process.nextTick(() => {
        // Below the <5%-remaining threshold in checkScrapingBeeCredits().
        res.emit('data', Buffer.from(JSON.stringify({ used_api_credit: 999999, max_api_credit: 1000000 })));
        res.emit('end');
      });
    });
    return req;
  };
  return { restore: () => { https.get = original; }, callCount: () => calls };
}

function freshScraper() {
  delete require.cache[require.resolve('./scraper.js')];
  return require('./scraper.js');
}

test('checkScrapingBeeCredits trips sbCreditsLow, and fetchWithScrapingBee skips with no extra HTTP call once tripped', async () => {
  const mock = mockLowCreditsUsageEndpoint();
  const originalKey = process.env.SCRAPINGBEE_API_KEY;
  process.env.SCRAPINGBEE_API_KEY = 'test-key';
  try {
    const scraper = freshScraper();
    assert.equal(scraper.sbCreditsLow, false, 'starts false before any check has run');

    const ok = await scraper.checkScrapingBeeCredits();
    assert.equal(ok, false, 'checkScrapingBeeCredits reports credits unavailable');
    assert.equal(scraper.sbCreditsLow, true, 'latch tripped');
    assert.equal(mock.callCount(), 1, 'exactly one /usage call');

    const callsBefore = mock.callCount();
    const result = await scraper.fetchWithScrapingBee('https://example.com/review');
    assert.equal(result, null, 'fetchWithScrapingBee returns null once sbCreditsLow is true');
    assert.equal(mock.callCount(), callsBefore, 'no additional HTTP call — the new guard short-circuits before any network work');
  } finally {
    mock.restore();
    if (originalKey === undefined) delete process.env.SCRAPINGBEE_API_KEY;
    else process.env.SCRAPINGBEE_API_KEY = originalKey;
  }
});

test('fetchWithScrapingBee fires the fire-and-forget latch check on its own first call (no caller opt-in required)', async () => {
  const mock = mockLowCreditsUsageEndpoint();
  const originalKey = process.env.SCRAPINGBEE_API_KEY;
  process.env.SCRAPINGBEE_API_KEY = 'test-key';
  try {
    const scraper = freshScraper();
    assert.equal(scraper.sbCreditsLow, false);

    // Nobody calls checkScrapingBeeCredits() explicitly here — historically
    // that meant sbCreditsLow stayed false all process (the exact bug).
    await scraper.fetchWithScrapingBee('https://example.com/review');
    await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget check resolve

    assert.equal(scraper.sbCreditsLow, true, 'fetchWithScrapingBee itself triggered the proactive check without a caller opting in');
  } finally {
    mock.restore();
    if (originalKey === undefined) delete process.env.SCRAPINGBEE_API_KEY;
    else process.env.SCRAPINGBEE_API_KEY = originalKey;
  }
});

test('url-discovery.js SERP path (S1-T6) consults the shared scraper singleton, not an independent flag', () => {
  delete require.cache[require.resolve('./scraper.js')];
  delete require.cache[require.resolve('./url-discovery.js')];
  const scraper = require('./scraper.js');
  const urlDiscovery = require('./url-discovery.js');

  // url-discovery.js does `const scraper = require('./scraper')` — under
  // CommonJS's module cache this MUST be the identical object our test just
  // required, or sbCreditsLow set from one call site would be invisible from
  // the other (the original bug's shape, one flag away).
  const scraperViaOwnCache = require.cache[require.resolve('./scraper.js')].exports;
  assert.equal(scraperViaOwnCache, scraper, 'sanity: require cache is shared within this test');

  // Structural regression guard: _serpViaScrapingBee isn't exported (it's an
  // internal helper reached only via serpQuery -> _serpWithChain), so assert
  // directly on the source that the SERP call site fires the same latch
  // fetchWithScrapingBee now fires — catches the wiring silently regressing
  // without re-deriving a full serpQuery() integration harness (SD/BD keys,
  // disk SERP cache, negative-cache TTLs) that isn't this fix's concern.
  const src = fs.readFileSync(require.resolve('./url-discovery.js'), 'utf8');
  const fnStart = src.indexOf('async function _serpViaScrapingBee');
  assert.ok(fnStart > -1, '_serpViaScrapingBee exists');
  const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart));
  assert.match(fnBody, /scraper\.checkScrapingBeeCredits\(\)/, '_serpViaScrapingBee fires the shared proactive latch check');
  assert.match(fnBody, /scraper\.sbCreditsLow/, '_serpViaScrapingBee still gates on the shared sbCreditsLow flag');

  void urlDiscovery; // imported to prove it loads cleanly with the shared scraper singleton
});
