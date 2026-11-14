import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-breaker-telemetry-'));
const ledger = path.join(scratch, 'ledger.jsonl');
Object.assign(process.env, {
  SCRAPINGDOG_API_KEY: 'test-sd', SCRAPER_USE_SCRAPINGDOG: '1',
  SD_CAPS_DISABLED: '1', BD_CAPS_DISABLED: '1', SB_CAPS_DISABLED: '1',
  BD_SERP_CACHE_DISABLED: '1', SERP_BREAKER_COOLDOWN_MS: '1000',
  SCRAPER_SPEND_LEDGER_PATH: ledger,
});
delete process.env.BD_TELEMETRY_DISABLED;
delete process.env.SERP_NO_SB;
delete process.env.BRIGHTDATA_TOKEN;
delete process.env.SCRAPINGBEE_API_KEY;
const require = createRequire(import.meta.url);
const axios = require('axios');
const scraper = require('../../scripts/lib/scraper');
const quiet = () => {};
const rows = () => fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
const error400 = () => Object.assign(new Error('request rejected'), { response: { status: 400 } });
const organic = { organic_results: [{ url: 'https://example.test/review', title: 'Review' }] };
let discovery;
let now;

beforeEach((t) => {
  fs.rmSync(ledger, { force: true });
  now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'log', quiet);
  t.mock.method(scraper, 'checkScrapingdogQuotaOnce', quiet);
  t.mock.method(scraper, 'checkScrapingBeeCredits', quiet);
  delete require.cache[require.resolve('../../scripts/lib/url-discovery')];
  discovery = require('../../scripts/lib/url-discovery');
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function assertCorrelation(recorded) {
  assert.equal(new Set(recorded.map(r => r.run_id)).size, 1);
  assert.match(recorded[0].run_id, /^[0-9a-f-]{36}$/);
  assert.ok(recorded.every((r, i) => Number.isInteger(r.run_seq) && (!i || r.run_seq > recorded[i - 1].run_seq)));
  assert.ok(!JSON.stringify(recorded).includes('test-sd'));
}

test('SD organic rows prove five failures, cooldown skips, failed probe and recovery in one run', async (t) => {
  let sdOk = false;
  t.mock.method(axios, 'get', async (url) => {
    if (url.includes('scrapingdog') && !sdOk) throw error400();
    return { data: organic };
  });
  const call = () => discovery.serpQuery('real caller query', { scrapingBeeKey: 'test-sb', log: quiet });
  for (let i = 0; i < 5; i++) await call();
  let sd = rows().filter(r => r.provider === 'scrapingdog');
  assert.deepEqual(sd.map(r => r.breaker.consecutive_failures), [1, 2, 3, 4, 5]);
  assert.equal(sd[4].breaker.opened_at, null, 'SD starts cooldown on the next blocked call');
  assert.ok(sd.every(r => !r.breaker.probe));
  await call(); // blocked; establishes cooldown without another paid call
  assert.equal(rows().filter(r => r.provider === 'scrapingdog').length, 5);
  assert.equal(rows().at(-1).fallback_from, null);
  now += 1000;
  await call(); // failed half-open probe
  sd = rows().filter(r => r.provider === 'scrapingdog');
  assert.deepEqual(sd.at(-1).breaker, {
    consecutive_failures: 6, opened_at: now, threshold: 5, cooldown_ms: 1000, probe: true,
  });
  await call();
  assert.equal(rows().filter(r => r.provider === 'scrapingdog').length, 6);
  sdOk = true;
  now += 1000;
  await call(); // successful probe resets the same breaker
  await call(); // normal closed-state request
  sd = rows().filter(r => r.provider === 'scrapingdog');
  assert.deepEqual(sd.slice(-2).map(r => [r.success, r.breaker.consecutive_failures, r.breaker.opened_at, r.breaker.probe]),
    [[true, 0, null, true], [true, 0, null, false]]);
  assertCorrelation(rows());
  assert.ok(rows().filter(r => r.provider === 'scrapingbee').every(r => !r.breaker));
});

test('BD subpaths share the run, count their failures and identify the admitted recovery probe', async (t) => {
  // The async SERP API fallback is opt-in since BRO-6482; this test covers it.
  process.env.BD_SERP_ASYNC_FALLBACK = '1';
  t.after(() => { delete process.env.BD_SERP_ASYNC_FALLBACK; });
  let apiOk = false;
  t.mock.method(axios, 'post', async () => { throw error400(); });
  t.mock.method(globalThis, 'fetch', async (url) => apiOk
    ? { ok: true, status: 200, json: async () => url.includes('get_result')
      ? { organic: organic.organic_results } : { response_id: 'test-response' } }
    : { ok: false, status: 400 });
  t.mock.method(globalThis, 'setTimeout', (fn) => { fn(); return 0; });
  const call = () => discovery.serpQuery('BD caller query', {
    brightDataKey: 'test-bd', skipProviders: ['scrapingdog', 'scrapingbee'], log: quiet,
  });
  for (let i = 0; i < 3; i++) await call();
  assert.deepEqual(rows().map(r => r.breaker.consecutive_failures), [1, 2, 3, 4, 5, 6]);
  assert.ok(rows().every(r => !r.breaker.probe), 'async fallback is not a new half-open admission');
  await call();
  assert.equal(rows().length, 6, 'cooldown skip adds no call/event row');
  apiOk = true;
  now += 1000;
  await call();
  assert.deepEqual(rows().slice(-2).map(r => [r.fn, r.breaker.consecutive_failures, r.breaker.probe]),
    [['serp-unlocker', 7, true], ['serp-api', 0, true]]);
  assert.deepEqual(rows().at(-1).breaker, {
    consecutive_failures: 0, opened_at: null, threshold: 5, cooldown_ms: 1000, probe: true,
  });
  assertCorrelation(rows());
});

test('BD short HTML records the actual unchanged breaker counter', async (t) => {
  t.mock.method(axios, 'post', async () => ({ data: 'short' }));
  await discovery.serpQuery('short HTML query', {
    brightDataKey: 'test-bd', skipProviders: ['scrapingdog', 'scrapingbee'], log: quiet,
  });
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].success, false);
  assert.equal(rows()[0].status, 'short_html');
  assert.equal(rows()[0].breaker.consecutive_failures, 0);
});

test('images breaker snapshots remain independent of the organic SD breaker', async (t) => {
  let ok = false;
  t.mock.method(axios, 'get', async () => {
    if (!ok) throw error400();
    return { data: { images_results: [], ...organic } };
  });
  const call = () => discovery.serpImagesQuery('poster query', { scrapingdogKey: 'test-sd', log: quiet });
  for (let i = 0; i < 5; i++) await call();
  assert.deepEqual(rows().map(r => r.breaker.consecutive_failures), [1, 2, 3, 4, 5]);
  await call();
  assert.equal(rows().length, 5);
  now += 1000;
  ok = true;
  await call();
  assert.equal(rows().at(-1).breaker.probe, true);
  assert.equal(rows().at(-1).breaker.consecutive_failures, 0);
  await discovery.serpQuery('organic caller query', { scrapingBeeKey: 'test-sb', log: quiet });
  assert.equal(rows().at(-1).host, 'serp.scrapingdog');
  assert.equal(rows().at(-1).breaker.probe, false);
  assertCorrelation(rows());
});

test('different Node processes using the same workflow get distinct run identifiers', () => {
  const source = `require('./scripts/lib/provider-telemetry').recordSdCall({host:'serp.scrapingdog',fn:'serp',success:true})`;
  const record = () => JSON.parse(execFileSync(process.execPath, ['-e', source], {
    cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8',
    env: { ...process.env, GITHUB_WORKFLOW: 'same-workflow', SCRAPER_SPEND_LEDGER_PATH: path.join(scratch, 'child.jsonl') },
  }).trim().slice('[SD Call] '.length));
  const a = record();
  const b = record();
  assert.match(a.run_id, /^[0-9a-f-]{36}$/);
  assert.notEqual(a.run_id, b.run_id);
  assert.equal(a.workflow, b.workflow);
  assert.equal(a.run_seq, 1);
  assert.equal(b.run_seq, 1);
});
