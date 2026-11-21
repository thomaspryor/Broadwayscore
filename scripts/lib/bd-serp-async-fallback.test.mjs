/**
 * Unit tests for bdSerpAsyncFallbackEnabled (BRO-6482) in url-discovery.js.
 *
 * Run: node --test scripts/lib/bd-serp-async-fallback.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { bdSerpAsyncFallbackEnabled } = require('./url-discovery.js');

test('off by default', () => {
  assert.equal(bdSerpAsyncFallbackEnabled({}), false);
  assert.equal(bdSerpAsyncFallbackEnabled({ BD_SERP_ASYNC_FALLBACK: '' }), false);
});

test('opt-in values turn it on', () => {
  for (const v of ['1', 'true', 'TRUE', ' true ']) {
    assert.equal(bdSerpAsyncFallbackEnabled({ BD_SERP_ASYNC_FALLBACK: v }), true, v);
  }
});

test('anything else stays off', () => {
  for (const v of ['0', 'false', 'no', 'yes', 'on']) {
    assert.equal(bdSerpAsyncFallbackEnabled({ BD_SERP_ASYNC_FALLBACK: v }), false, v);
  }
});

// Drive the real chain with the network stubbed: Web Unlocker times out, then
// check whether the async SERP API (POST .../serp/req) is attempted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-async-'));
process.env.BD_SERP_CACHE_DIR = path.join(tmp, 'serp-cache');
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(tmp, 'ledger.jsonl');
// Spend caps read real ledger/breaker state on CI and can skip BD before this
// code runs, which would make both chain tests pass or fail vacuously.
Object.assign(process.env, {
  SD_CAPS_DISABLED: '1', BD_CAPS_DISABLED: '1', SB_CAPS_DISABLED: '1', BD_SERP_CACHE_DISABLED: '1',
});

const axios = require('axios');
const unlockerCalls = [];
axios.post = async (url) => { unlockerCalls.push(String(url)); throw new Error('timeout of 30000ms exceeded'); };
const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  return { ok: false, status: 503, json: async () => ({}) };
};
const { _serpWithChainForTests: chain } = require('./url-discovery.js');
const onlyBd = new Set(['scrapingdog', 'scrapingbee']);
let n = 0;
const runBd = () => chain(`"Async Probe Show" review ${n++}`, null, 'bd-key', () => {}, null, false, undefined, onlyBd);

test('unlocker failure no longer triggers the async SERP API by default', async () => {
  delete process.env.BD_SERP_ASYNC_FALLBACK;
  fetchCalls.length = 0;
  unlockerCalls.length = 0;
  const r = await runBd();
  assert.equal(unlockerCalls.length, 1, 'Web Unlocker must actually be tried');
  assert.equal(r.results, null);
  assert.deepEqual(fetchCalls.filter((u) => u.includes('/serp/req')), []);
});

test('BD_SERP_ASYNC_FALLBACK=1 restores the old async fallback', async () => {
  process.env.BD_SERP_ASYNC_FALLBACK = '1';
  fetchCalls.length = 0;
  await runBd();
  delete process.env.BD_SERP_ASYNC_FALLBACK;
  assert.equal(fetchCalls.filter((u) => u.includes('/serp/req')).length, 1);
});
