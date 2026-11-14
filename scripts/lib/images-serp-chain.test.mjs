// BRO-3377: Google Images SERP goes Scrapingdog first (10 cr), ScrapingBee
// (25 cr) only as fallback. Requires the REAL url-discovery functions (§15);
// axios is stubbed on the shared module object, so no network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

process.env.SCRAPINGDOG_API_KEY = 'sd-test-key';
process.env.SD_CAPS_DISABLED = '1';
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(os.tmpdir(), `images-serp-chain-${process.pid}.jsonl`);
// BRO-6483: isolate from the live data/audit circuit-breaker state CI rewrites
process.env.BD_BREAKER_STATE_PATH = path.join(os.tmpdir(), `images-serp-bd-${process.pid}.json`);
process.env.SB_BREAKER_STATE_PATH = path.join(os.tmpdir(), `images-serp-sb-${process.pid}.json`);
delete process.env.SERP_NO_SB;

const require = createRequire(import.meta.url);
const axios = require('axios');
const scraper = require('./scraper.js');
scraper.checkScrapingdogQuotaOnce = () => {};
const { serpImagesQuery, normalizeScrapingdogImageResults, imagesSerpChainOrder } = require('./url-discovery.js');

const SD_BODY = { images_results: [
  { title: 'Show Poster', image: 'https://encrypted-tbn0.gstatic.com/t1', original: 'https://cdn.example.com/poster.jpg', link: 'https://www.playbill.com/show', source: 'Playbill', original_width: 600, original_height: 900, rank: 1 },
  { title: 'Inline', image: 'data:image/jpeg;base64,AAAA', original: '', link: 'https://news.test/a', source: 'News' },
  { title: 'Nothing usable', image: '', original: null, link: 'https://x.test' },
] };

let calls;
const quiet = () => {};
beforeEach(() => { calls = []; });
function stubAxios(handler) {
  axios.get = async (url, cfg) => { calls.push(url); return handler(url, cfg); };
}

test('normalizeScrapingdogImageResults maps to the direct-URL candidate shape', () => {
  const r = normalizeScrapingdogImageResults(SD_BODY);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { image: null, imageUrl: 'https://cdn.example.com/poster.jpg', url: 'https://www.playbill.com/show', title: 'Show Poster', domain: 'www.playbill.com', width: 600, height: 900, _directUrl: true });
  assert.equal(r[1].imageUrl, null);
  assert.equal(r[1].image, 'data:image/jpeg;base64,AAAA');
  assert.deepEqual(normalizeScrapingdogImageResults(null), []);
});

test('imagesSerpChainOrder: Scrapingdog first, ScrapingBee fallback, skips honoured', () => {
  assert.deepEqual(imagesSerpChainOrder({ sdKey: 'a', sbKey: 'b' }), ['scrapingdog', 'scrapingbee']);
  assert.deepEqual(imagesSerpChainOrder({ sdKey: '', sbKey: 'b' }), ['scrapingbee']);
  assert.deepEqual(imagesSerpChainOrder({ sdKey: 'a', sbKey: 'b', skip: ['scrapingbee'] }), ['scrapingdog']);
});

test('Scrapingdog success never calls ScrapingBee', async () => {
  stubAxios(async () => ({ data: SD_BODY }));
  const r = await serpImagesQuery('"Show" broadway poster', { scrapingBeeKey: 'sb', log: quiet });
  assert.equal(r.provider, 'scrapingdog');
  assert.equal(r.failed, false);
  assert.equal(r.results.length, 2);
  assert.deepEqual(calls, ['https://api.scrapingdog.com/google_images']);
});

test('Scrapingdog empty result is final (no 25-credit ScrapingBee retry)', async () => {
  stubAxios(async () => ({ data: { images_results: [] } }));
  const r = await serpImagesQuery('q', { scrapingBeeKey: 'sb', log: quiet });
  assert.deepEqual([r.provider, r.results.length], ['scrapingdog', 0]);
  assert.equal(calls.length, 1);
});

test('Scrapingdog failure falls back to ScrapingBee', async () => {
  stubAxios(async (url) => {
    if (url.includes('scrapingdog')) { const e = new Error('boom'); e.response = { status: 500 }; throw e; }
    return { data: { images: [{ image: 'data:image/png;base64,AA', url: 'https://p.test' }] } };
  });
  const r = await serpImagesQuery('q', { scrapingBeeKey: 'sb', log: quiet });
  assert.equal(r.provider, 'scrapingbee');
  assert.equal(r.results.length, 1);
  assert.deepEqual(calls, ['https://api.scrapingdog.com/google_images', 'https://app.scrapingbee.com/api/v1/store/google']);
});

test('both tiers failing reports failed, with ScrapingBee exhaustion surfaced', async () => {
  stubAxios(async (url) => { const e = new Error('x'); e.response = { status: url.includes('scrapingbee') ? 401 : 503 }; throw e; });
  const r = await serpImagesQuery('q', { scrapingBeeKey: 'sb', log: quiet });
  assert.deepEqual({ failed: r.failed, exhausted: r.exhausted }, { failed: true, exhausted: true });
});
