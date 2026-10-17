// Smoke test for the REAL Scrapingdog failure path (BRO-3325 hotfix, 2026-09-15):
// a9d790dfb18 referenced sdBilledCredits inside fetchWithScrapingdog without
// importing it, so every SD failure threw ReferenceError instead of returning
// null — which also escaped fetchPage()'s tier loop and broke the SD → BD → SB
// fallback. The pure-function tests were green because nothing drove the call
// site. This test forces a failure through fetchWithScrapingdog itself and
// asserts: no throw, null result, and a 0-credit failure row in the ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Env must be set BEFORE scraper.js loads: it reads SCRAPINGDOG_API_KEY at
// module scope, and provider-telemetry resolves the ledger path per write.
const ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-smoke-')), 'ledger.jsonl');
process.env.SCRAPINGDOG_API_KEY = process.env.SCRAPINGDOG_API_KEY || 'test-key-not-real';
process.env.SCRAPER_SPEND_LEDGER_PATH = ledgerPath;
process.env.SCRAPINGDOG_SKIP_QUOTA_CHECK = '1';

const https = require('node:https');
const realGet = https.get;
// Every outbound SD request fails with SD's own uncharged 400 body. A 4xx is
// non-transient in fetchWithScrapingdog, so exactly one attempt is made.
https.get = function stubbedGet(_url, _opts, cb) {
  const req = new EventEmitter();
  req.destroy = () => {};
  req.setTimeout = () => req;
  process.nextTick(() => req.emit('error', new Error(
    'Scrapingdog HTTP 400: Oops! Something went wrong. You won’t be charged for this request.')));
  if (typeof _opts === 'function') cb = _opts;
  void cb;
  return req;
};

const { fetchWithScrapingdog } = require('../../scripts/lib/scraper.js');

test('a Scrapingdog failure returns null (never throws) and books a 0-credit failure row', async () => {
  let result;
  try {
    result = await fetchWithScrapingdog('https://example.com/some-review', { fallbackFrom: null });
  } catch (err) {
    assert.fail(`fetchWithScrapingdog threw instead of returning null: ${err && err.stack}`);
  } finally {
    https.get = realGet;
  }
  assert.equal(result, null);
  const rows = fs.existsSync(ledgerPath)
    ? fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const failure = rows.find((r) => r.provider === 'scrapingdog' && r.host === 'example.com' && r.success === false);
  assert.ok(failure, `expected a scrapingdog failure row for example.com in the ledger, got: ${JSON.stringify(rows).slice(0, 600)}`);
  assert.equal(failure.credits, 0, 'failed SD calls must book 0 credits (sdBilledCredits)');
});
