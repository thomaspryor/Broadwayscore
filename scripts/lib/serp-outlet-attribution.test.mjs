// BRO-6537: exercise real discovery and ledger writers with provider I/O stubbed.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-outlet-attribution-'));
const ledger = path.join(tmp, 'ledger.jsonl');
Object.assign(process.env, {
  SCRAPINGDOG_API_KEY: 'sd-test-only', SCRAPER_USE_SCRAPINGDOG: '1',
  SCRAPER_SPEND_LEDGER_PATH: ledger, BD_SERP_CACHE_DISABLED: '1',
  SD_CAPS_DISABLED: '1', SB_CAPS_DISABLED: '1', BD_CAPS_DISABLED: '1',
});
delete process.env.BD_TELEMETRY_DISABLED;
delete process.env.SCRAPER_SPEND_SHOW_ID;
delete process.env.SERP_NO_SB;
delete process.env.BD_SERP_ASYNC_FALLBACK;

const require = createRequire(import.meta.url);
const axios = require('axios');
const scraper = require('./scraper.js');
const { discoverCorrectUrl, serpQuery } = require('./url-discovery.js');
const { recordSdCall, withSpendShow, withSpendOutlet } = require('./provider-telemetry.js');
const originalGet = axios.get;
const originalPost = axios.post;
const originalFetch = global.fetch;
const originalQuotaCheck = scraper.checkScrapingdogQuotaOnce;
const originalCreditCheck = scraper.checkScrapingBeeCredits;
scraper.checkScrapingdogQuotaOnce = () => {};
scraper.checkScrapingBeeCredits = () => {};

const review = { showId: 'telemetry-attribution-fixture-2026', outletId: 'Guardian', url: '', criticName: 'Unknown' };
const article = { url: 'https://example.com/2026/telemetry-attribution-fixture-review', title: 'Telemetry Attribution Fixture theatre review' };
const options = { domainOverride: 'example.com', forceHistorical: true, log: () => {}, brightDataKey: 'bd-test-only' };
const rows = () => fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
const discover = (r = review) => discoverCorrectUrl(r, 'sb-test-only', options);
function fail(status) {
  const error = new Error(`Provider returned ${status}`);
  error.response = { status, data: { message: 'Invalid query parameter' } };
  throw error;
}
function assertAttribution(records, r = review) {
  assert.ok(records.length > 0, 'must exercise real provider telemetry');
  for (const row of records) {
    assert.equal(row.outletId, r.outletId.toLowerCase());
    assert.equal(row.showId, r.showId);
    assert.ok(!JSON.stringify(row).includes('Telemetry Attribution Fixture'), 'no query text in ledger');
  }
}

beforeEach(() => {
  fs.rmSync(ledger, { force: true });
  axios.get = async () => ({ data: { organic_results: [article] } });
  axios.post = async () => { throw new Error('Unexpected POST'); };
  global.fetch = async () => { throw new Error('Unexpected fetch'); };
});
after(() => {
  axios.get = originalGet;
  axios.post = originalPost;
  global.fetch = originalFetch;
  scraper.checkScrapingdogQuotaOnce = originalQuotaCheck;
  scraper.checkScrapingBeeCredits = originalCreditCheck;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('discovery records the requested outlet and show on a successful SD row', async () => {
  assert.equal(await discover(), article.url);
  assert.equal(rows().length, 1);
  assertAttribution(rows());
});

test('SD retry keeps attribution and books the same attempts', async () => {
  let calls = 0;
  axios.get = async () => {
    if (++calls === 1) fail(503);
    return { data: { organic_results: [article] } };
  };
  assert.equal(await discover(), article.url);
  assert.equal(calls, 2);
  assert.equal(rows()[0].credits, 10);
  assertAttribution(rows());
});

test('SD failure and Bright Data Web Unlocker success both carry attribution', async () => {
  axios.get = async () => fail(400);
  axios.post = async () => ({ data: { organic: [article] } });
  assert.equal(await discover(), article.url);
  assert.deepEqual(rows().map(r => r.provider), ['scrapingdog', 'brightdata']);
  assert.equal(rows()[1].fallback_from, 'serp-api');
  assertAttribution(rows());
});

test('SD, both Bright Data paths, and SB keep attribution through a fallback chain', async () => {
  process.env.BD_SERP_ASYNC_FALLBACK = '1';
  axios.get = async (url) => {
    if (url.includes('scrapingdog')) fail(400);
    return { data: { organic_results: [article] } };
  };
  axios.post = async () => fail(400);
  global.fetch = async () => ({ ok: false, status: 503 });
  try {
    assert.equal(await discover(), article.url);
    assert.deepEqual(rows().map(r => r.provider), ['scrapingdog', 'brightdata', 'brightdata', 'scrapingbee']);
    assert.equal(rows().at(-1).fallback_from, 'brightdata');
    assertAttribution(rows());
  } finally {
    delete process.env.BD_SERP_ASYNC_FALLBACK;
  }
});

test('concurrent discoveries isolate outlet/show context and leave bare SERP calls unchanged', async () => {
  const other = { ...review, showId: 'second-attribution-fixture-2026', outletId: 'nytimes' };
  axios.get = async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return { data: { organic_results: [] } };
  };
  await Promise.all([discover(), discover(other)]);
  const attributed = rows();
  assert.equal(attributed.length, 2);
  assert.deepEqual(attributed.map(r => [r.showId, r.outletId]).sort(), [
    [review.showId, 'guardian'], [other.showId, 'nytimes'],
  ].sort());
  await serpQuery('Unscoped attribution probe', { scrapingBeeKey: 'sb-test-only', log: () => {} });
  assert.equal(rows().at(-1).showId, null);
  assert.equal('outletId' in rows().at(-1), false);
});

test('query variants retain attribution when the first search returns no results', async () => {
  let calls = 0;
  axios.get = async () => ({ data: { organic_results: ++calls === 1 ? [] : [article] } });
  const r = { ...review, criticName: 'Fixture Critic' };
  assert.equal(await discover(r), article.url);
  assert.equal(calls, 2);
  assertAttribution(rows());
});

test('explicit outlet beats context, nested context restores the previous outlet', () => {
  withSpendShow('outer-show', () => withSpendOutlet('Guardian', () => {
    withSpendOutlet('nytimes', () => recordSdCall({ host: 'serp.test', success: true, outletId: 'TheaterMania' }));
    recordSdCall({ host: 'serp.test', success: true });
  }));
  recordSdCall({ host: 'serp.test', success: true });
  assert.deepEqual(rows().map(r => [r.outletId ?? null, r.showId]), [
    ['theatermania', 'outer-show'], ['guardian', 'outer-show'], [null, null],
  ]);
});
