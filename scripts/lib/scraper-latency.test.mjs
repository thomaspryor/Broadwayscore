import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-latency-'));
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(dir, 'ledger.jsonl');
process.env.BRIGHTDATA_TOKEN = 'test-token';
process.env.SCRAPINGBEE_API_KEY = 'test-token';
process.env.SCRAPINGDOG_API_KEY = 'test-token';
const https = require('node:https');
const scraper = require('./scraper');
const { latencyByProvider } = require('./provider-spend-core');

test('provider calls write measured latency for success, failure and retry', async () => {
  const get = https.get, request = https.request, now = Date.now;
  let clock = 1000, dogCalls = 0, failDog = false;
  Date.now = () => clock;
  function response(url, callback) {
    const req = new EventEmitter();
    req.end = () => {};
    req.destroy = () => {};
    process.nextTick(() => {
      const res = new EventEmitter();
      const isDog = String(url).includes('/scrape?') || String(url).includes('/youtube/');
      res.statusCode = isDog && (++dogCalls === 1 || failDog) ? 500 : 200;
      res.headers = {};
      callback(res);
      clock += 125;
      res.emit('data', String(url).includes('/account?') || String(url).includes('/usage?') ? '{}' : '<html>ok</html>');
      res.emit('end');
    });
    return req;
  }
  https.get = (url, opts, cb) => response(url, typeof opts === 'function' ? opts : cb);
  https.request = (url, opts, cb) => response(url, cb);
  try {
    await scraper.fetchWithBrightData('https://example.com/one');
    await scraper.fetchWithScrapingBee('https://example.com/two');
    await scraper.fetchWithScrapingdog('https://example.com/three');
    const rows = fs.readFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, 'utf8').trim().split('\n').map(JSON.parse).filter(r => ['web-unlocker', 'page'].includes(r.fn));
    assert.deepEqual(rows.map(r => [r.provider, r.success, r.elapsed_ms]), [
      ['brightdata', true, 125], ['scrapingbee', true, 250],
      ['scrapingdog', true, 125],
    ]);
    fs.writeFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, '');
    failDog = true; dogCalls = 0;
    await scraper.fetchWithScrapingdog('https://example.com/failure');
    let failures = fs.readFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(failures.map(r => [r.provider, r.success, r.elapsed_ms, r.credits]), [['scrapingdog', false, 125, 0]]);
    fs.writeFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, '');
    dogCalls = 0;
    await scraper.fetchScrapingdogYouTube('video', 'test');
    failures = fs.readFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(failures.map(r => [r.provider, r.success, r.elapsed_ms, r.credits]), [['scrapingdog', false, 125, 0]]);
  } finally {
    https.get = get; https.request = request; Date.now = now;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nearest rank latency percentiles ignore missing and invalid values', () => {
  const rows = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, null, -1].map(elapsed_ms => ({ ts: '2026-11-27T10:00:00Z', provider: 'scrapingdog', fn: 'render', elapsed_ms }));
  rows.push({ ts: '2026-11-26T10:00:00Z', provider: 'scrapingdog', fn: 'render', elapsed_ms: 999 });
  rows.push({ ts: '2026-11-27T10:00:00Z', provider: 'scrapingbee', fn: 'page', elapsed_ms: 7 });
  assert.deepEqual(latencyByProvider(rows, '2026-11-27'), [
    { provider: 'scrapingbee', fn: 'page', count: 1, p50: 7, p90: 7 },
    { provider: 'scrapingdog', fn: 'render', count: 10, p50: 50, p90: 90 },
  ]);
});
