#!/usr/bin/env node
/**
 * Regression test: Scrapingdog empty-but-successful SERP results must be
 * authoritative — they must NOT cascade to the BD/SB chain (2026-07-05 SB burn
 * incident: SD empties re-asked via ScrapingBee at 25 credits/query, every
 * poll cycle, invisibly). Also verifies the SD_EMPTY_CASCADE=1 escape hatch
 * and that _serpViaScrapingBee now emits [SB Call] telemetry.
 *
 * Tests the REAL serpQuery/_serpWithChain from url-discovery.js (no copied
 * logic) by stubbing axios in require.cache before the module loads.
 */

process.env.SCRAPER_USE_SCRAPINGDOG = '1';
process.env.SCRAPINGDOG_API_KEY = 'test-sd-key';
process.env.BD_SERP_CACHE_DISABLED = '1';
delete process.env.SD_EMPTY_CASCADE;

// ---- Stub axios BEFORE url-discovery loads (it lazily require()s axios) ----
const calls = [];
let sdOrganic = [];   // what the fake Scrapingdog returns
let sbOrganic = [];   // what the fake ScrapingBee returns
const fakeAxios = {
  get: async (apiUrl) => {
    if (apiUrl.includes('scrapingdog.com/google')) {
      calls.push('sd');
      return { data: { organic_results: sdOrganic } };
    }
    if (apiUrl.includes('scrapingbee.com/api/v1/store/google')) {
      calls.push('sb');
      return { data: { organic_results: sbOrganic } };
    }
    calls.push(`other:${apiUrl.slice(0, 40)}`);
    throw new Error('unexpected endpoint');
  },
};
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: fakeAxios };

const { serpQuery } = require('./lib/url-discovery');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const quiet = () => {};

(async () => {
  console.log('1. SD empty-success is authoritative (no SB/BD cascade)');
  calls.length = 0; sdOrganic = [];
  const r1 = await serpQuery('test empty query one', { scrapingBeeKey: 'test-sb-key', log: quiet, preferSpeed: true });
  check('returns empty array (not null)', Array.isArray(r1) && r1.length === 0, `got ${JSON.stringify(r1)}`);
  check('only Scrapingdog was called', calls.join(',') === 'sd', `calls: ${calls.join(',')}`);

  console.log('2. SD non-empty results returned as-is');
  calls.length = 0; sdOrganic = [{ link: 'https://example.com/review', title: 'A Review' }];
  const r2 = await serpQuery('test nonempty query two', { scrapingBeeKey: 'test-sb-key', log: quiet });
  check('returns the SD result', r2?.length === 1 && r2[0].url === 'https://example.com/review', JSON.stringify(r2));
  check('only Scrapingdog was called', calls.join(',') === 'sd', `calls: ${calls.join(',')}`);

  console.log('3. SD_EMPTY_CASCADE=1 escape hatch restores old cascade');
  process.env.SD_EMPTY_CASCADE = '1';
  calls.length = 0; sdOrganic = []; sbOrganic = [{ url: 'https://example.com/sb-hit', title: 'SB Hit' }];
  const r3 = await serpQuery('test cascade query three', { scrapingBeeKey: 'test-sb-key', log: quiet, preferSpeed: true });
  check('cascades to ScrapingBee', calls.includes('sb'), `calls: ${calls.join(',')}`);
  check('returns the SB result', r3?.length === 1 && r3[0].url === 'https://example.com/sb-hit', JSON.stringify(r3));
  delete process.env.SD_EMPTY_CASCADE;

  console.log('4. SB SERP success emits [SB Call] telemetry (25 credits)');
  // preferSpeed + SD error (axios throws) → falls through to SB primary
  const origGet = fakeAxios.get;
  fakeAxios.get = async (apiUrl) => {
    if (apiUrl.includes('scrapingdog.com/google')) { calls.push('sd'); throw Object.assign(new Error('boom'), { response: { status: 500 } }); }
    return origGet(apiUrl);
  };
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  calls.length = 0; sbOrganic = [{ url: 'https://example.com/sb2', title: 't' }];
  await serpQuery('test telemetry query four', { scrapingBeeKey: 'test-sb-key', log: quiet, preferSpeed: true });
  console.log = origLog;
  fakeAxios.get = origGet;
  const sbCallLine = lines.find(l => l.startsWith('[SB Call] '));
  check('[SB Call] line emitted', !!sbCallLine, `lines: ${lines.slice(0, 3).join(' | ')}`);
  if (sbCallLine) {
    const rec = JSON.parse(sbCallLine.slice('[SB Call] '.length));
    check('credits=25, fn=serp, success=true', rec.credits === 25 && rec.fn === 'serp' && rec.success === true, sbCallLine);
  }

  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
