// BRO-3344: a SERP call made because Scrapingdog already failed carries
// fallback_from on its ledger row, and the Scrapingdog failure row carries a
// query-free detail (provider message + request shape). Requires the REAL
// url-discovery and provider-telemetry code (§15); axios is stubbed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEDGER = path.join(os.tmpdir(), `serp-fallback-attr-${process.pid}.jsonl`);
process.env.SCRAPINGDOG_API_KEY = 'sd-test-key';
process.env.SD_CAPS_DISABLED = '1';
process.env.BD_SERP_CACHE_DISABLED = '1';
process.env.SCRAPER_SPEND_LEDGER_PATH = LEDGER;
delete process.env.SERP_NO_SB;
delete process.env.BRIGHTDATA_TOKEN;
delete process.env.SCRAPINGBEE_API_KEY;

const require = createRequire(import.meta.url);
const axios = require('axios');
const scraper = require('./scraper.js');
scraper.checkScrapingdogQuotaOnce = () => {};
scraper.checkScrapingBeeCredits = () => {};
const { serpQuery, serpImagesQuery, scrapingdogSerpFailureDetail } = require('./url-discovery.js');

const quiet = () => {};
const rows = () => { try { return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
const origLog = console.log;
beforeEach(() => { fs.rmSync(LEDGER, { force: true }); });

function sd400ThenSb(sbBody) {
  axios.get = async (url) => {
    if (url.includes('scrapingdog')) {
      const e = new Error('Request failed with status code 400');
      e.response = { status: 400, data: { success: false, message: 'Invalid query parameter' } };
      throw e;
    }
    return { data: sbBody };
  };
}

test('organic: SD 400 -> ScrapingBee row is tagged fallback_from scrapingdog; SD row has detail', async () => {
  sd400ThenSb({ organic_results: [{ url: 'https://ok.test/r', title: 'r' }] });
  console.log = () => {};
  let r;
  try {
    r = await serpQuery('"Some Show" review site:example.com', { scrapingBeeKey: 'sb', log: quiet });
  } finally { console.log = origLog; }
  assert.deepEqual(r.map((x) => x.url), ['https://ok.test/r']);
  const sd = rows().find((x) => x.provider === 'scrapingdog');
  const sb = rows().find((x) => x.provider === 'scrapingbee');
  assert.equal(sd.status, 400);
  assert.equal(sd.detail.msg, 'Invalid query parameter');
  assert.equal(sd.detail.quoted, true);
  assert.equal(sd.detail.ops, 1);
  assert.equal(sb.fallback_from, 'scrapingdog');
  assert.equal(sb.success, true);
});

test('images: SD failure -> ScrapingBee images row is tagged fallback_from scrapingdog', async () => {
  sd400ThenSb({ images: [{ image: 'data:image/png;base64,AA', url: 'https://p.test' }] });
  console.log = () => {};
  try {
    await serpImagesQuery('poster q', { scrapingBeeKey: 'sb', log: quiet });
  } finally { console.log = origLog; }
  const sb = rows().find((x) => x.provider === 'scrapingbee');
  assert.equal(sb.fallback_from, 'scrapingdog');
});

test('scrapingdogSerpFailureDetail never stores the query text', () => {
  const e = { response: { status: 400, data: 'Bad Request' } };
  const d = scrapingdogSerpFailureDetail(e, 'Wicked review after:2024-01-01 before:2024-02-01', 'uk', 1, true);
  assert.deepEqual(d, { msg: 'Bad Request', qlen: 48, quoted: false, ops: 2, nonAscii: false, geo: 'uk', page: 1, dated: true });
  assert.ok(!JSON.stringify(d).includes('Wicked'));
  assert.equal(scrapingdogSerpFailureDetail(new Error('timeout'), 'Café', null, 0, false).nonAscii, true);
});

test('detail keeps only the provider message, with the key and the query scrubbed', () => {
  const q = 'Wicked review site:nytimes.com';
  const echo = { response: { status: 400, data: { message: `bad request for ${q} api_key=sd-test-key&query=${encodeURIComponent(q)}` } } };
  const d = scrapingdogSerpFailureDetail(echo, q, null, 0, false);
  assert.ok(!d.msg.includes('Wicked') && !d.msg.includes('sd-test-key'), d.msg);
  assert.match(d.msg, /\[query\]/);
  // A body with no message/error string is not copied wholesale.
  const raw = { response: { status: 400, data: { echo: { query: q, api_key: 'sd-test-key' } } } };
  assert.equal(scrapingdogSerpFailureDetail(raw, q, null, 0, false).msg, null);
});

test('images: a 200 with no images_results falls back to ScrapingBee instead of ending empty', async () => {
  axios.get = async (url) => (url.includes('scrapingdog')
    ? { data: { success: false, error: 'something' } }
    : { data: { images: [{ image: 'data:image/png;base64,AA', url: 'https://p.test' }] } });
  console.log = () => {};
  let r;
  try { r = await serpImagesQuery('poster q2', { scrapingBeeKey: 'sb', log: quiet }); } finally { console.log = origLog; }
  assert.equal(r.provider, 'scrapingbee');
  const sd = rows().find((x) => x.provider === 'scrapingdog');
  assert.equal(sd.success, false);
  assert.equal(rows().find((x) => x.provider === 'scrapingbee').fallback_from, 'scrapingdog');
});

test('images: a Scrapingdog that never sent a request (quota latch) is not named as fallback_from', async () => {
  sd400ThenSb({ images: [{ image: 'data:image/png;base64,AA', url: 'https://p.test' }] });
  const desc = Object.getOwnPropertyDescriptor(scraper, 'sdQuotaExceeded');
  Object.defineProperty(scraper, 'sdQuotaExceeded', { get: () => true, configurable: true });
  console.log = () => {};
  try { await serpImagesQuery('poster q3', { scrapingBeeKey: 'sb', log: quiet }); } finally { console.log = origLog; Object.defineProperty(scraper, 'sdQuotaExceeded', desc); }
  assert.equal(rows().filter((x) => x.provider === 'scrapingdog').length, 0);
  assert.equal(rows().find((x) => x.provider === 'scrapingbee').fallback_from, null);
});
