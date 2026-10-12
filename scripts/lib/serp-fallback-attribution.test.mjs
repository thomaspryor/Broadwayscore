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
