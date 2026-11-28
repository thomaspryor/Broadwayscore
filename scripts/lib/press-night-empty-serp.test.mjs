/**
 * BRO-5914: on press night an empty Scrapingdog SERP is "not indexed yet".
 * Drives the real _serpWithChain with axios stubbed, so no network and no spend.
 * Run: node --test scripts/lib/press-night-empty-serp.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-serp-'));
process.env.SCRAPINGDOG_API_KEY = 'sd-test';
process.env.SCRAPER_USE_SCRAPINGDOG = '1';
process.env.BD_SERP_CACHE_DIR = path.join(tmp, 'serp-cache');
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(tmp, 'ledger.jsonl');
// BRO-6483: isolate the daily circuit-breaker state files. Left unset they read the
// committed data/audit/*-circuit-breaker.json, which CI rewrites, so a tripped BD
// breaker on main made "another show is unaffected" return null.
process.env.BD_BREAKER_STATE_PATH = path.join(tmp, 'bd-breaker.json');
process.env.SD_BREAKER_STATE_PATH = path.join(tmp, 'sd-breaker.json');
process.env.SB_BREAKER_STATE_PATH = path.join(tmp, 'sb-breaker.json');

const require = createRequire(import.meta.url);
const axios = require('axios');
const calls = [];
const stub = async (url) => {
  calls.push(String(url));
  return { status: 200, data: { organic_results: [], organic_data: [] } };
};
axios.get = stub;
axios.post = stub;

const { _serpWithChainForTests: chain } = require('./url-discovery.js');
const caps = require('./scrapingdog-caps.js');
const sp = require('./spend-purpose.js');

const TAG = sp.pressNightPurpose('show-a-2026', '2026-10-29');
const log = () => {};
let q = 0;
const hosts = () => calls.map((u) => new URL(u).host);

beforeEach(() => {
  calls.length = 0;
  caps._resetForTests();
  fs.rmSync(process.env.SCRAPER_SPEND_LEDGER_PATH, { force: true });
  process.env.SCRAPER_SPEND_PURPOSE = TAG;
});

const run = (emptyAuthoritative) =>
  chain(`"Press Night Show" review ${q++}`, 'sb-key', 'bd-key', log, null, false, undefined, undefined, emptyAuthoritative);

test('baseline: empty SD answer is accepted as final when emptyAuthoritative is true (today)', async () => {
  const r = await run(true);
  assert.deepEqual(r.results, []);
  assert.equal(r.provider, 'scrapingdog-empty');
  assert.deepEqual(hosts().filter((h) => !h.includes('scrapingdog')), []);
});

test('press night (emptyAuthoritative:false): empty SD answer falls through to SB/BD and is not accepted as final', async () => {
  const r = await run(false);
  assert.notEqual(r.provider, 'scrapingdog-empty');
  assert.ok(hosts().some((h) => h.includes('scrapingbee')), `calls: ${hosts().join(',')}`);
});

test('press night: the empty answer is not cached, so the next tick asks again', async () => {
  const query = `"Cache Probe Show" review ${q++}`;
  await chain(query, 'sb-key', 'bd-key', log, null, false, undefined, undefined, false);
  const first = calls.length;
  await chain(query, 'sb-key', 'bd-key', log, null, false, undefined, undefined, false);
  assert.ok(calls.length > first, 'second ask must hit providers again');
});

test('capped show-night: no provider is called at all, result is null (-> __SERP_UNAVAILABLE__)', async () => {
  const rows = Array.from({ length: 1400 }, () => JSON.stringify({ provider: 'brightdata', credits: null, purpose: TAG }));
  fs.writeFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, rows.join('\n') + '\n');
  const r = await run(false);
  assert.equal(r.results, null);
  assert.equal(r.provider, 'press-night-capped');
  assert.equal(calls.length, 0);
});

test('capped show-night blocks escalation even when SD itself is skipped', async () => {
  const rows = Array.from({ length: 1400 }, () => JSON.stringify({ provider: 'brightdata', credits: null, purpose: TAG }));
  fs.writeFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, rows.join('\n') + '\n');
  const r = await chain(`"Skip SD" review ${q++}`, 'sb-key', 'bd-key', log, null, false, undefined, ['scrapingdog'], false);
  assert.equal(r.results, null);
  assert.equal(calls.length, 0);
});

test('another show (or an off-night call) is unaffected by a capped show', async () => {
  const rows = Array.from({ length: 1400 }, () => JSON.stringify({ provider: 'brightdata', credits: null, purpose: TAG }));
  fs.writeFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, rows.join('\n') + '\n');
  process.env.SCRAPER_SPEND_PURPOSE = sp.pressNightPurpose('show-b-2026', '2026-10-29');
  assert.ok(calls.length === 0 && (await run(false)).results !== null);
  calls.length = 0;
  process.env.SCRAPER_SPEND_PURPOSE = '';
  assert.ok((await run(true)).results !== null);
});

test('press night: an EMPTY answer cached earlier (authoritative gather) does not win', async () => {
  const query = `"Stale Empty Show" review ${q++}`;
  const r1 = await chain(query, 'sb-key', 'bd-key', log, null, false, undefined, undefined, true);
  assert.equal(r1.provider, 'scrapingdog-empty');
  const afterFirst = calls.length;
  const r2 = await chain(query, 'sb-key', 'bd-key', log, null, false, undefined, undefined, false);
  assert.ok(calls.length > afterFirst, 'press-night ask must go live, not read the cached empty');
  assert.ok(!String(r2.provider).endsWith('-cached'));
});

test('fallback attribution accepts the press-night-cap skip reason (no throw)', () => {
  const fa = require('./fallback-attribution.js');
  assert.doesNotThrow(() => fa.fallbackFromLabel('brightdata', { skipReason: 'press-night-cap' }));
});

test('consultScrapingdog press-night block logs once per show-night tag, not once per process', () => {
  const rows = Array.from({ length: 1400 }, () => JSON.stringify({ provider: 'brightdata', credits: null, purpose: TAG }));
  fs.writeFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, rows.join('\n') + '\n');
  const other = sp.pressNightPurpose('show-c-2026', '2026-10-29');
  fs.appendFileSync(process.env.SCRAPER_SPEND_LEDGER_PATH, rows.map((r) => r.replace(TAG, other)).join('\n') + '\n');
  const first = (tag) => caps.consultScrapingdog({ env: { ...process.env, SCRAPER_SPEND_PURPOSE: tag } }).firstBlock;
  assert.equal(first(TAG), true);
  assert.equal(first(TAG), false);
  assert.equal(first(other), true);
});
