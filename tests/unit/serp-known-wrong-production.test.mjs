// BRO-7604: deleted wrong-production files must not be recreated by discovery.
// Provider I/O is stubbed; validation and discovery use the real implementations.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-known-wrong-'));
Object.assign(process.env, {
  SCRAPINGDOG_API_KEY: 'sd-test-only', SCRAPER_USE_SCRAPINGDOG: '1',
  SCRAPER_SPEND_LEDGER_PATH: path.join(tmp, 'ledger.jsonl'), BD_SERP_CACHE_DISABLED: '1',
  SD_CAPS_DISABLED: '1', SB_CAPS_DISABLED: '1', BD_CAPS_DISABLED: '1',
});
delete process.env.SERP_PREFETCH_VALIDATOR;
delete process.env.SERP_NO_SB;

const require = createRequire(import.meta.url);
const axios = require('axios');
const scraper = require('../../scripts/lib/scraper.js');
const { validateSerpCandidate } = require('../../scripts/lib/serp-candidate-validator.js');
const { discoverCorrectUrl } = require('../../scripts/lib/url-discovery.js');
const originalGet = axios.get;
const originalPost = axios.post;
const originalFetch = global.fetch;
const originalQuotaCheck = scraper.checkScrapingdogQuotaOnce;
scraper.checkScrapingdogQuotaOnce = () => {};
axios.post = async () => { throw new Error('Unexpected provider POST'); };
global.fetch = async () => { throw new Error('Unexpected provider fetch'); };
after(() => {
  axios.get = originalGet;
  axios.post = originalPost;
  global.fetch = originalFetch;
  scraper.checkScrapingdogQuotaOnce = originalQuotaCheck;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const show = {
  id: 'frankie-and-johnny-in-the-clair-de-lune-2002',
  title: 'Frankie and Johnny in the Clair de Lune', category: 'broadway',
};
// Confirmed in the 2019 production's real THR record, published 2019-05-30.
const wrongUrl = 'http://www.hollywoodreporter.com/review/frankie-johnny-clair-de-lune-theater-1214274';
const candidate = { url: wrongUrl, title: 'Frankie and Johnny in the Clair de Lune theater review' };

test('known wrong-production URL stays rejected without a review file or publication date', () => {
  for (const url of [
    wrongUrl,
    wrongUrl.replace('http:', 'https:'),
    wrongUrl.replace('http://www.', 'https://') + '/?utm_source=google#review',
  ]) {
    const result = validateSerpCandidate({ show, candidate: { ...candidate, url } });
    assert.equal(result.ok, false, url);
    assert.equal(result.reason, 'known-wrong-production-url');
  }
});

test('suppression is scoped to the exact show and article', () => {
  assert.equal(validateSerpCandidate({
    show: { ...show, id: 'frankie-and-johnny-in-the-clair-de-lune-2019' }, candidate,
  }).ok, true, 'the correct production keeps its THR review');
  for (const url of [
    'https://variety.com/2002/legit/reviews/frankie-and-johnny-in-the-clair-de-lune-3-1200546876/',
    'https://www.talkinbroadway.com/world/FrankieJohnny.html',
    wrongUrl + '-different-article',
    wrongUrl.replace('hollywoodreporter.com', 'other.example'),
  ]) {
    assert.equal(validateSerpCandidate({ show, candidate: { ...candidate, url } }).ok, true, url);
  }
});

test('real SERP discovery skips the tombstone and continues to another candidate', async () => {
  const review = { showId: show.id, outletId: 'hollywood-reporter', source: 'serp-discovery', url: '', criticName: 'Unknown' };
  const options = { forceHistorical: true, returnMetadata: true, log: () => {} };
  axios.get = async () => ({ data: { organic_results: [candidate] } });
  assert.equal(await discoverCorrectUrl(review, 'sb-test-only', options), null);

  const other = { ...candidate, url: wrongUrl + '-different-article' };
  axios.get = async () => ({ data: { organic_results: [candidate, other] } });
  assert.deepEqual(await discoverCorrectUrl(review, 'sb-test-only', options), {
    url: other.url, serpTitle: other.title,
  });
  assert.equal(await discoverCorrectUrl({ ...review, showId: 'frankie-and-johnny-in-the-clair-de-lune-2019' }, 'sb-test-only', options).then(r => r?.url), wrongUrl);
});
