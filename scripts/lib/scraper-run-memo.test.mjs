import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRunMemo } = require('./scraper-run-memo.js');

const H = 'talkinbroadway.com';
const fail = (tier) => ({ tier, attempted: true, ok: false });
const win = (tier) => ({ tier, attempted: true, ok: true });
const skip = (tier) => ({ tier, attempted: false, ok: false });

test('Bright Data latches after 2 failures that a later tier recovered', () => {
  const m = createRunMemo();
  assert.deepEqual(m.recordOutcome(H, [fail('brightdata'), win('scrapingbee')]), []);
  assert.deepEqual(m.recordOutcome(H, [fail('brightdata'), win('scrapingbee')]), [{ tier: 'brightdata', failures: 2 }]);
  assert.deepEqual([...m.skippedTiers(H)], ['brightdata']);
  assert.equal(m.skippedTiers('variety.com').size, 0, 'other hosts unaffected');
});

test('a latch is reported once', () => {
  const m = createRunMemo();
  m.recordOutcome(H, [fail('brightdata'), win('scrapingbee')]);
  m.recordOutcome(H, [fail('brightdata'), win('scrapingbee')]);
  assert.deepEqual(m.recordOutcome(H, [fail('brightdata'), win('scrapingbee')]), []);
});

test('Scrapingdog needs 3 failures (School Girls TB shape)', () => {
  const m = createRunMemo();
  m.recordOutcome(H, [fail('scrapingdog'), win('brightdata')]);
  m.recordOutcome(H, [fail('scrapingdog'), win('brightdata')]);
  assert.equal(m.skippedTiers(H).has('scrapingdog'), false);
  assert.deepEqual(m.recordOutcome(H, [fail('scrapingdog'), win('brightdata')]), [{ tier: 'scrapingdog', failures: 3 }]);
  assert.equal(m.skippedTiers(H).has('scrapingdog'), true);
  assert.equal(m.skippedTiers(H).has('brightdata'), false, 'the winning tier never latches');
});

test('Scrapingdog never latches on a host where it already succeeded this run', () => {
  const m = createRunMemo();
  m.recordOutcome(H, [win('scrapingdog')]);
  for (let i = 0; i < 6; i++) m.recordOutcome(H, [fail('scrapingdog'), win('brightdata')]);
  assert.equal(m.skippedTiers(H).has('scrapingdog'), false);
});

test('a success resets the consecutive count', () => {
  const m = createRunMemo();
  m.recordOutcome(H, [fail('brightdata'), win('scrapingbee')]);
  m.recordOutcome(H, [win('brightdata')]);
  m.recordOutcome(H, [fail('brightdata'), win('scrapingbee')]);
  assert.equal(m.skippedTiers(H).size, 0);
});

test('a URL that fails on every tier counts against no tier', () => {
  const m = createRunMemo();
  for (let i = 0; i < 5; i++) {
    m.recordOutcome(H, [fail('scrapingdog'), fail('brightdata'), fail('scrapingbee'), fail('playwright-last')]);
  }
  assert.equal(m.skippedTiers(H).size, 0);
});

test('a budget/quota skip is not a failure', () => {
  const m = createRunMemo();
  for (let i = 0; i < 4; i++) m.recordOutcome(H, [skip('scrapingbee'), win('playwright-last')]);
  assert.equal(m.skippedTiers(H).size, 0);
});

test('free tiers never latch', () => {
  const m = createRunMemo();
  for (let i = 0; i < 4; i++) m.recordOutcome(H, [fail('playwright-first'), fail('cookies-plain'), win('brightdata')]);
  assert.equal(m.skippedTiers(H).size, 0);
});

test('a tier after the winner is not counted', () => {
  const m = createRunMemo();
  for (let i = 0; i < 3; i++) m.recordOutcome(H, [win('scrapingdog'), fail('brightdata')]);
  assert.equal(m.skippedTiers(H).size, 0);
});

test('bad input is ignored', () => {
  const m = createRunMemo();
  assert.deepEqual(m.recordOutcome(null, [fail('brightdata')]), []);
  assert.deepEqual(m.recordOutcome(H, null), []);
  assert.equal(m.skippedTiers(undefined).size, 0);
});

// --- Through the real fetchPage (child process: scraper.js reads keys at load) ---
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Scrapingdog (https.get) always errors; Bright Data (https.request) always
// serves a page. Counts SD scrape attempts per fetch.
const CHILD = `
'use strict';
const https = require('https');
const { EventEmitter } = require('events');
let sdScrapes = 0;
function fakeRes(status, body) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.headers = {};
  setImmediate(() => { res.emit('data', body); res.emit('end'); });
  return res;
}
https.request = (url, opts, cb) => {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => cb(fakeRes(200, '<html><body>' + 'x'.repeat(4000) + '</body></html>'));
  req.destroy = () => {};
  req.setTimeout = () => {};
  return req;
};
https.get = (url) => {
  if (String(url).includes('/scrape?')) sdScrapes++;
  const req = new EventEmitter();
  setImmediate(() => req.emit('error', new Error('stubbed: SD down')));
  req.destroy = () => {};
  req.setTimeout = () => {};
  return req;
};
const { fetchPage } = require(process.env.SCRAPER_PATH);
(async () => {
  for (let i = 1; i <= 5; i++) {
    const before = sdScrapes;
    const out = await fetchPage('https://www.memo-test-outlet.example/reviews/review-' + i + '.html', { skipVerify: true });
    console.log('FETCH ' + i + ' source=' + out.source + ' sd=' + (sdScrapes - before));
  }
})().catch((e) => { console.log('CHILD_ERROR ' + e.message); process.exit(3); });
`;

function runChild(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4296-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  const child = path.join(dir, 'child.cjs');
  fs.writeFileSync(child, CHILD);
  const stdout = execFileSync(process.execPath, [child], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SCRAPER_PATH: path.join(HERE, 'scraper.js'),
      SCRAPER_SPEND_LEDGER_PATH: ledger,
      SD_BREAKER_STATE_PATH: path.join(dir, 'sd-circuit-breaker.json'),
      BD_BREAKER_STATE_PATH: path.join(dir, 'bd-circuit-breaker.json'),
      // BRO-3010: and the ScrapingBee breaker, should SB ever join this chain.
      SB_BREAKER_STATE_PATH: path.join(dir, 'sb-circuit-breaker.json'),
      SCRAPER_USE_SCRAPINGDOG: '1',
      SCRAPINGDOG_API_KEY: 'test-sd-key',
      BRIGHTDATA_TOKEN: 'test-bd-token',
      SCRAPINGBEE_API_KEY: '',
      SD_CAPS_DISABLED: '1',
      BD_CAPS_DISABLED: '1',
      BD_OPENING_NIGHT: '',
      GITHUB_WORKFLOW: '',
      SCRAPER_RUN_MEMO_DISABLED: '',
      ...extraEnv,
    },
  });
  const rows = fs.existsSync(ledger)
    ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  fs.rmSync(dir, { recursive: true, force: true });
  const sdPerFetch = [...stdout.matchAll(/FETCH \d+ source=(\S+) sd=(\d+)/g)].map((m) => Number(m[2]));
  return { stdout, rows, sdPerFetch };
}

test('fetchPage: after 3 SD failures that BD recovered, SD is not called again for the host', () => {
  const { stdout, rows, sdPerFetch } = runChild();
  assert.ok(!stdout.includes('CHILD_ERROR'), stdout);
  assert.equal(sdPerFetch.length, 5, stdout);
  assert.ok(sdPerFetch.slice(0, 3).every((n) => n > 0), `first 3 fetches try SD: ${sdPerFetch}`);
  assert.deepEqual(sdPerFetch.slice(3), [0, 0], `fetches 4-5 skip SD: ${sdPerFetch}`);
  assert.match(stdout, /run memo: scrapingdog failed 3x on memo-test-outlet\.example/);
  const memoRows = rows.filter((r) => r.fn === 'run-memo-skip');
  assert.equal(memoRows.length, 1, 'one ledger row per latch, not per skipped call');
  assert.equal(memoRows[0].provider, 'scrapingdog');
  assert.equal(memoRows[0].host, 'memo-test-outlet.example');
  assert.equal(memoRows[0].credits, 0);
});

test('fetchPage: SCRAPER_RUN_MEMO_DISABLED=true keeps trying SD every time', () => {
  const { stdout, sdPerFetch } = runChild({ SCRAPER_RUN_MEMO_DISABLED: 'true' });
  assert.ok(!stdout.includes('CHILD_ERROR'), stdout);
  assert.ok(sdPerFetch.length === 5 && sdPerFetch.every((n) => n > 0), `${sdPerFetch}`);
});
