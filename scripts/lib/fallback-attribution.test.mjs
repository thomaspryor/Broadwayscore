// fallback-attribution.test.mjs (BRO-3009 S1-T8).
//
// Two layers:
//   1. the pure label function, tested directly (CLAUDE.md §15 — the real
//      function scraper.js calls, never a copy);
//   2. an end-to-end check that fetchPage() ACTUALLY plumbs it: with
//      SD_BREAKER_STATE_PATH pointed at a tripped fixture, the Bright Data row
//      written to the spend ledger must carry fallback_from: 'sd-breaker'.
//
// Layer 2 runs in a child process because scraper.js reads its provider
// keys/flags at module load, and it stubs https.request/https.get before
// requiring scraper.js so no real provider is ever contacted. The stub is
// installed by mutating the shared `https` module object, which is the same
// object scraper.js's own `require('https')` returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fallbackFromLabel } = require('./fallback-attribution.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- layer 1 --

test('the first tier in a chain has nothing to attribute', () => {
  assert.equal(fallbackFromLabel(null), null);
  assert.equal(fallbackFromLabel(null, { breakerBlocked: true }), null);
});

test('a tier that was tried and missed is labelled by its own chain name', () => {
  assert.equal(fallbackFromLabel('scrapingdog'), 'scrapingdog');
  assert.equal(fallbackFromLabel('brightdata'), 'brightdata');
  assert.equal(fallbackFromLabel('cookies-plain'), 'cookies-plain');
  assert.equal(fallbackFromLabel('playwright-first'), 'playwright-first');
});

test('a breaker-blocked Scrapingdog is "sd-breaker", NOT "scrapingdog"', () => {
  // The whole point: BRO-3011 joins spend to breaker trip windows, so "never
  // attempted, the day cap was shut" must be distinguishable from "attempted
  // and missed" — they are opposite cost stories.
  assert.equal(fallbackFromLabel('scrapingdog', { skipReason: 'sd-breaker' }), 'sd-breaker');
  assert.notEqual(fallbackFromLabel('scrapingdog', { skipReason: 'sd-breaker' }), 'scrapingdog');
});

test('the other never-attempted states are attributed too, not collapsed to the tier name', () => {
  assert.equal(fallbackFromLabel('scrapingdog', { skipReason: 'sd-quota' }), 'sd-quota');
  assert.equal(fallbackFromLabel('scrapingdog', { skipReason: 'sd-budget' }), 'sd-budget');
  assert.equal(fallbackFromLabel('brightdata', { skipReason: 'bd-budget' }), 'bd-budget');
});

test('an unknown skipReason throws instead of leaking a typo into the ledger', () => {
  assert.throws(
    () => fallbackFromLabel('scrapingdog', { skipReason: 'sd-breakr' }),
    /unknown skipReason "sd-breakr"/,
  );
});

// ---------------------------------------------------------------- layer 2 --

const CHILD = `
'use strict';
// Stub the network BEFORE scraper.js is loaded. scraper.js does
// require('https') and holds the module object, so mutating it here is seen
// there. Nothing in this test may touch a real provider.
const https = require('https');
const { EventEmitter } = require('events');

function fakeRes(status, body) {
  const res = new EventEmitter();
  res.statusCode = status;
  setImmediate(() => { res.emit('data', body); res.emit('end'); });
  return res;
}
// Bright Data (POST via https.request) — succeed with plausible article HTML.
https.request = (url, opts, cb) => {
  const req = new EventEmitter();
  req.end = () => cb(fakeRes(200, '<html><body>' + 'x'.repeat(4000) + '</body></html>'));
  req.destroy = () => {};
  return req;
};
// Scrapingdog account pre-check (https.get) — fail fast, never a real call.
https.get = () => {
  const req = new EventEmitter();
  setImmediate(() => req.emit('error', new Error('stubbed: no network in tests')));
  req.destroy = () => {};
  return req;
};

const { fetchPage } = require(process.env.SCRAPER_PATH);

(async () => {
  // Root-path URL: fetchPage skips URL verification for pathname '/', so the
  // stubbed body is accepted without needing to fake a matching canonical.
  const out = await fetchPage('https://example.com/');
  console.log('SOURCE=' + out.source);
})().catch((e) => { console.log('CHILD_ERROR ' + e.message); process.exit(3); });
`;

function runChain({ breakerTripped }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro3009-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  const breaker = path.join(dir, 'sd-circuit-breaker.json');
  const child = path.join(dir, 'child.cjs');

  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    breaker,
    JSON.stringify(
      breakerTripped
        // isBreakerActive(): same UTC day + a non-null trippedAt.
        ? { day, trippedAt: new Date().toISOString(), dayCredits: 999999, ceiling: 1000 }
        : { day, trippedAt: null, dayCredits: 1, ceiling: 1000 },
    ),
  );
  fs.writeFileSync(child, CHILD);

  // execFileSync returns STDOUT; scraper.js's own tier logging goes there too,
  // so the child's markers are printed to stdout rather than stderr.
  const stdout = execFileSync(process.execPath, [child], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SCRAPER_PATH: path.join(HERE, 'scraper.js'),
      SCRAPER_SPEND_LEDGER_PATH: ledger,
      SD_BREAKER_STATE_PATH: breaker,
      // SD must be IN the chain for the breaker to be what removes it —
      // otherwise the test would pass for the wrong reason (SD never ordered).
      SCRAPER_USE_SCRAPINGDOG: '1',
      SCRAPINGDOG_API_KEY: 'test-sd-key',
      BRIGHTDATA_TOKEN: 'test-bd-token',
      // Keep ScrapingBee out of the chain so Bright Data is unambiguously the
      // tier that follows Scrapingdog.
      SCRAPINGBEE_API_KEY: '',
      SD_CAPS_DISABLED: '',
      BD_OPENING_NIGHT: '',
      GITHUB_WORKFLOW: '',
    },
  }).toString();

  const rows = fs.existsSync(ledger)
    ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { rows, stdout };
}

test('TRIPPED breaker: the Bright Data ledger row carries fallback_from "sd-breaker"', () => {
  const { rows, stdout } = runChain({ breakerTripped: true });
  assert.ok(!stdout.includes('CHILD_ERROR'), `child failed: ${stdout}`);
  assert.ok(stdout.includes('SOURCE=brightdata'), `expected BD to serve the fetch: ${stdout}`);

  const bd = rows.filter((r) => r.provider === 'brightdata' && r.success === true);
  assert.equal(bd.length, 1, `expected exactly one successful BD row, got ${rows.length} rows total`);
  assert.equal(
    bd[0].fallback_from,
    'sd-breaker',
    'the BD row must say the SD breaker is why Bright Data was reached',
  );
});

test('breaker NOT tripped: BD is reached by an ordinary SD miss, not attributed to the breaker', () => {
  // Same chain, same stubs — only the breaker fixture differs. SD is attempted
  // and fails (its https.get is stubbed to error), so the label is the plain
  // tier name. This is the control that proves the assertion above is reading
  // the breaker and not just "BD always says sd-breaker".
  const { rows, stdout } = runChain({ breakerTripped: false });
  assert.ok(!stdout.includes('CHILD_ERROR'), `child failed: ${stdout}`);

  const bd = rows.filter((r) => r.provider === 'brightdata' && r.success === true);
  assert.equal(bd.length, 1, 'expected exactly one successful BD row');
  assert.equal(bd[0].fallback_from, 'scrapingdog');
  assert.notEqual(bd[0].fallback_from, 'sd-breaker');
});

test('every ledger row carries a fallback_from key (the column is populated, not dropped)', () => {
  const { rows } = runChain({ breakerTripped: true });
  assert.ok(rows.length > 0, 'expected at least one ledger row');
  for (const r of rows) {
    assert.ok('fallback_from' in r, `row missing fallback_from: ${JSON.stringify(r)}`);
  }
});
