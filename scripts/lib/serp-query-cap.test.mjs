/**
 * BRO-7171 Stage 2: per-process live SERP query cap (SERP_QUERY_BUDGET),
 * enforced inside url-discovery's _serpWithChain. Drives the real chain with
 * axios stubbed: no network, no spend.
 * Run: node --test scripts/lib/serp-query-cap.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-qcap-'));
process.env.SCRAPINGDOG_API_KEY = 'sd-test';
process.env.SCRAPER_USE_SCRAPINGDOG = '1';
process.env.BD_SERP_CACHE_DIR = path.join(tmp, 'serp-cache');
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(tmp, 'ledger.jsonl');
process.env.BD_BREAKER_STATE_PATH = path.join(tmp, 'bd-breaker.json');
process.env.SD_BREAKER_STATE_PATH = path.join(tmp, 'sd-breaker.json');
process.env.SB_BREAKER_STATE_PATH = path.join(tmp, 'sb-breaker.json');
delete process.env.SCRAPER_SPEND_PURPOSE;

const require = createRequire(import.meta.url);
const axios = require('axios');
const calls = [];
const stub = async (url) => {
  calls.push(String(url));
  return { status: 200, data: { organic_results: [{ link: 'https://example.com/a', title: 'A' }], organic_data: [] } };
};
axios.get = stub;
axios.post = stub;

const ud = require('./url-discovery.js');
const { parseSerpQueryBudget, serpQueryBudgetAllows } = require('./serp-query-cap.js');
const log = () => {};
let q = 0;
const run = (query = `"Cap Probe Show" review ${q++}`) => ud._serpWithChainForTests(query, 'sb-key', 'bd-key', log, null, false);

beforeEach(() => {
  calls.length = 0;
  ud._resetSerpQueryCountForTests();
  delete process.env.SERP_QUERY_BUDGET;
});

test('parse: only a strict positive integer is a cap', () => {
  assert.equal(parseSerpQueryBudget('3'), 3);
  for (const raw of [undefined, '', '0', '-2', '5abc', 'NaN', '1.5', 'abc']) assert.equal(parseSerpQueryBudget(raw), null, String(raw));
  assert.deepEqual(serpQueryBudgetAllows(9, undefined), { allowed: true, budget: null });
  assert.deepEqual(serpQueryBudgetAllows(1, '2'), { allowed: true, budget: 2 });
  assert.deepEqual(serpQueryBudgetAllows(2, '2'), { allowed: false, budget: 2 });
});

test('no env: unlimited, every query reaches a provider (unchanged default)', async () => {
  for (let i = 0; i < 4; i++) {
    const r = await run();
    assert.ok(Array.isArray(r.results));
  }
  assert.equal(ud.getSerpQueryCount(), 4);
  assert.ok(calls.length >= 4);
});

test('SERP_QUERY_BUDGET=2: third live query calls no provider and returns null (-> __SERP_UNAVAILABLE__)', async () => {
  process.env.SERP_QUERY_BUDGET = '2';
  await run();
  await run();
  const before = calls.length;
  const r = await run();
  assert.equal(r.results, null);
  assert.equal(r.provider, 'serp-query-capped');
  assert.equal(calls.length, before, 'no provider called once capped');
});

test('cache hits are free: a repeated query after the cap still answers from cache', async () => {
  process.env.SERP_QUERY_BUDGET = '1';
  const query = `"Cached Cap Show" review ${q++}`;
  const first = await run(query);
  assert.ok(Array.isArray(first.results) && first.results.length, 'first live query answered');
  const again = await run(query);
  assert.ok(Array.isArray(again.results) && again.results.length, 'cache answers after cap');
  assert.match(String(again.provider), /cached/);
  assert.equal(ud.getSerpQueryCount(), 1);
});
