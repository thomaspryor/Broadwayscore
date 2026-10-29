import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { createSbHostCooldown } = require('./scrapingbee-host-cooldown');
const NOW = Date.parse('2026-10-23T06:00:00Z');
const failures = (age = 1) => Array.from({ length: 6 }, () => ({
  provider: 'scrapingbee', host: 'example.com', success: false, credits: 1,
  ts: new Date(NOW - age * 3600e3).toISOString(),
}));

test('invalid targets never reach SB, even with the kill switch enabled', () => {
  const guard = createSbHostCooldown({ env: { SB_HOST_COOLDOWN_DISABLED: '1' }, readRows: () => { throw Error('unneeded read'); } });
  for (const url of [null, undefined, '', 'bad-url', 'file:///tmp/a', 'mailto:a@example.com']) {
    assert.equal(guard.consult(url).allowed, false);
  }
  assert.equal(guard.consult('https://example.com/a').allowed, true);
});

test('cache refreshes after a minute and live failures immediately re-arm probes', () => {
  let time = NOW;
  let reads = 0;
  const guard = createSbHostCooldown({ now: () => time, env: {}, readRows: () => { reads++; return failures(7); } });
  assert.equal(guard.consult('https://www.example.com/a').probe, true);
  assert.equal(guard.consult('https://example.com/b').allowed, false, 'one in-flight probe per host');
  guard.record('https://example.com/a', false);
  assert.equal(guard.consult('https://example.com/b').allowed, false, 'no stale-cache repeat probe');
  assert.equal(guard.consult('https://healthy.com/a').allowed, true, 'host isolation');
  assert.equal(reads, 1);
  guard.record('https://example.com/a', true);
  assert.equal(guard.consult('https://example.com/a').allowed, true);
  time += 60e3;
  guard.consult('https://healthy.com/a');
  assert.equal(reads, 2);
});

test('new in-run failures trip the guard and both kill switches remain scoped', () => {
  const env = {};
  const guard = createSbHostCooldown({ env, now: () => NOW, readRows: () => [] });
  assert.equal(guard.consult('https://example.com/a').allowed, true);
  for (let i = 0; i < 6; i++) guard.record('https://example.com/a', false);
  assert.equal(guard.consult('https://example.com/a').allowed, false);
  env.REDDIT_SB_COOLDOWN_DISABLED = '1';
  assert.equal(guard.consult('https://example.com/a').allowed, false);
  for (let i = 0; i < 6; i++) guard.record('https://reddit.com/a', false);
  assert.equal(guard.consult('https://reddit.com/a').allowed, true);
  env.SB_HOST_COOLDOWN_DISABLED = '1';
  assert.equal(guard.consult('https://example.com/a').allowed, true);
});

test('real scraper HTML/JSON calls skip cooled hosts without paid HTTP or spend', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5917-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(ledger, failures().map(r => JSON.stringify({ ...r, ts: new Date().toISOString() })).join('\n') + '\n');
  const overrides = {
    SCRAPER_SPEND_LEDGER_PATH: ledger, SCRAPINGBEE_API_KEY: 'test-key',
    SCRAPINGDOG_API_KEY: '', BRIGHTDATA_TOKEN: '', SCRAPER_USE_SCRAPINGDOG: '0',
    SB_HOST_COOLDOWN_DISABLED: '', REDDIT_SB_COOLDOWN_DISABLED: '',
  };
  for (const [key, value] of Object.entries(overrides)) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
  let paid = 0;
  t.mock.method(https, 'get', (url, options, callback) => {
    const target = new URL(url);
    const req = new EventEmitter();
    process.nextTick(() => {
      if (target.hostname !== 'app.scrapingbee.com') { req.emit('error', Error('direct blocked')); return; }
      const usage = target.pathname.endsWith('/usage');
      if (!usage) paid++;
      const res = new EventEmitter();
      res.statusCode = 200;
      callback(res);
      process.nextTick(() => {
        res.emit('data', usage ? '{"used_api_credit":0,"max_api_credit":1000000}' : '<p>working page</p>');
        res.emit('end');
      });
    });
    return req;
  });
  // scraper.js tops an empty BRIGHTDATA_TOKEN up from a local .env (load-env
  // readEnvKeys), so on a developer Mac Bright Data answered and wrote a 7th
  // ledger row; CI has no .env. Keep the top-up out of this test.
  t.mock.method(require('./load-env'), 'readEnvKeys', () => ({}));
  delete require.cache[require.resolve('./scraper')];
  const scraper = require('./scraper');
  const skips = [];
  assert.equal(await scraper.fetchWithScrapingBee('https://www.example.com/a', { onSkip: reason => skips.push(reason) }), null);
  assert.deepEqual(skips, ['sb-host-cooldown']);
  await assert.rejects(() => scraper.fetchJSON('https://example.com/wp-json'));
  assert.equal(paid, 0);
  assert.equal(scraper.getScraperStats().sbRequests, 0);
  assert.equal(fs.readFileSync(ledger, 'utf8').trim().split('\n').length, 6, 'skips do not create failure rows');
  const result = await scraper.fetchWithScrapingBee('https://healthy.com/a');
  assert.equal(result.source, 'scrapingbee');
  assert.equal(paid, 1, 'working hosts retain the paid fallback');
});
