// Runs in test.yml's blocking batch: the fixture show is not in data/shows.json, so getShowInfo takes its slug fallback with or without core data.
// BRO-7531: discoverCorrectUrl ran its fallback searches only on a literally empty answer. When Scrapingdog
// ignores the site: filter the answer is non-empty but all off-domain, so the fallbacks were skipped and the
// host gate then rejected every row. Real discovery with provider I/O stubbed.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-offdomain-fallback-'));
Object.assign(process.env, {
  SCRAPINGDOG_API_KEY: 'sd-test-only', SCRAPER_USE_SCRAPINGDOG: '1',
  SCRAPER_SPEND_LEDGER_PATH: path.join(tmp, 'ledger.jsonl'), BD_SERP_CACHE_DISABLED: '1',
  SD_CAPS_DISABLED: '1', SB_CAPS_DISABLED: '1', BD_CAPS_DISABLED: '1',
});
delete process.env.SERP_NO_SB;
delete process.env.SERP_SITE_REASK;

const require = createRequire(import.meta.url);
const axios = require('axios');
const scraper = require('./scraper.js');
const { discoverCorrectUrl } = require('./url-discovery.js');
const originalGet = axios.get;
const originalPost = axios.post;
const originalQuotaCheck = scraper.checkScrapingdogQuotaOnce;
const originalCreditCheck = scraper.checkScrapingBeeCredits;
scraper.checkScrapingdogQuotaOnce = () => {};
scraper.checkScrapingBeeCredits = () => {};

const review = { showId: 'offdomain-fallback-fixture-2026', outletId: 'Guardian', url: '', criticName: 'Jane Critic' };
const article = { link: 'https://example.com/2026/offdomain-fallback-fixture-review', title: 'Offdomain Fallback Fixture theatre review' };
const junk = [
  { link: 'https://www.youtube.com/watch?v=abc', title: 'Offdomain Fallback Fixture trailer' },
  { link: 'https://forum.broadwayworld.com/thread/Offdomain-Fallback-Fixture', title: 'Offdomain Fallback Fixture thread' },
];
const options = { domainOverride: 'example.com', forceHistorical: true, log: () => {}, brightDataKey: 'bd-test-only' };
let queries = [];

beforeEach(() => {
  queries = [];
  axios.get = async (url, cfg) => {
    const query = String((cfg && cfg.params && (cfg.params.query || cfg.params.search || cfg.params.q)) || '');
    queries.push(query);
    return { data: { organic_results: /site:/.test(query) ? junk : [article] } };
  };
  axios.post = async () => { throw new Error('Unexpected POST'); };
});
after(() => {
  axios.get = originalGet;
  axios.post = originalPost;
  scraper.checkScrapingdogQuotaOnce = originalQuotaCheck;
  scraper.checkScrapingBeeCredits = originalCreditCheck;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('an all-off-domain answer to the site: query still runs the no-site fallback, which finds the review', async () => {
  const found = await discoverCorrectUrl(review, 'sb-test-only', options);
  assert.equal(found, article.link);
  const siteAsks = queries.filter((x) => /site:example\.com/.test(x)).length;
  assert.equal(siteAsks, 2, 'the site: query is asked, then re-asked once');
  assert.ok(queries.some((x) => !/site:/.test(x) && /Jane Critic/.test(x)), 'the no-site critic-name fallback ran');
});

test('an on-domain answer to the site: query is used directly, with no fallback search', async () => {
  axios.get = async (url, cfg) => { queries.push(String(cfg.params.query || '')); return { data: { organic_results: [article] } }; };
  const found = await discoverCorrectUrl(review, 'sb-test-only', options);
  assert.equal(found, article.link);
  assert.equal(queries.length, 1);
});
