// Integration test: verify runSERPBackup actually passes the right brightDataKey
// based on show.category. Catches regressions where the gate is present but not
// wired through to discoverCorrectUrl.
//
// Strategy: intercept ./lib/url-discovery in the require cache BEFORE loading
// the poller, so our stubbed discoverCorrectUrl captures every arg.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const urlDiscoveryPath = require.resolve('../../scripts/lib/url-discovery.js');

// Capture every discoverCorrectUrl call for later assertions.
const capturedCalls = [];
require.cache[urlDiscoveryPath] = {
  id: urlDiscoveryPath,
  filename: urlDiscoveryPath,
  loaded: true,
  exports: {
    discoverCorrectUrl: async (reviewObj, scrapingBeeKey, options = {}) => {
      capturedCalls.push({
        showId: reviewObj.showId,
        outletId: reviewObj.outletId,
        scrapingBeeKey,
        brightDataKey: options.brightDataKey,
        preferSpeed: options.preferSpeed,
      });
      return null; // "not found" — keeps runSERPBackup iterating through outlets
    },
    OUTLET_DOMAINS: {},
  },
};

// Now load poller — it will resolve url-discovery from the cached stub.
const { runSERPBackup, SERP_BUDGET } = require('../../scripts/opening-night-poller.js');

// Fake environment so SB/BD keys appear "set" to runSERPBackup
process.env.SCRAPINGBEE_API_KEY = 'test-sb-key';
process.env.BRIGHTDATA_TOKEN = 'test-bd-key';

function makeOutlets(n) {
  const outlets = [];
  for (let i = 0; i < n; i++) {
    outlets.push({
      id: `fake-outlet-${i}`,
      name: `Fake Outlet ${i}`,
      domain: `fake-outlet-${i}.example.com`,
    });
  }
  return outlets;
}

test('runSERPBackup passes real BD key for broadway shows', async () => {
  capturedCalls.length = 0;
  const show = { id: 'broadway-show-2026', category: 'broadway' };
  await runSERPBackup(show, makeOutlets(3), new Set());

  assert.ok(capturedCalls.length > 0, 'discoverCorrectUrl should have been called');
  for (const call of capturedCalls) {
    assert.equal(call.brightDataKey, 'test-bd-key',
      `BW should forward BD key, got ${JSON.stringify(call.brightDataKey)}`);
    assert.equal(call.scrapingBeeKey, 'test-sb-key');
  }
});

test('runSERPBackup passes real BD key for west-end shows', async () => {
  capturedCalls.length = 0;
  const show = { id: 'we-show-2026', category: 'west-end' };
  await runSERPBackup(show, makeOutlets(3), new Set());

  assert.ok(capturedCalls.length > 0);
  for (const call of capturedCalls) {
    assert.equal(call.brightDataKey, 'test-bd-key', 'WE should forward BD key');
  }
});

test('runSERPBackup drops BD key for off-broadway shows', async () => {
  capturedCalls.length = 0;
  const show = { id: 'ob-show-2026', category: 'off-broadway' };
  await runSERPBackup(show, makeOutlets(3), new Set());

  assert.ok(capturedCalls.length > 0);
  for (const call of capturedCalls) {
    assert.equal(call.brightDataKey, '',
      `OB should drop BD key, got ${JSON.stringify(call.brightDataKey)}`);
    assert.equal(call.scrapingBeeKey, 'test-sb-key', 'SB key still forwarded');
  }
});

test('runSERPBackup drops BD key for off-west-end shows', async () => {
  capturedCalls.length = 0;
  const show = { id: 'owe-show-2026', category: 'off-west-end' };
  await runSERPBackup(show, makeOutlets(3), new Set());

  assert.ok(capturedCalls.length > 0);
  for (const call of capturedCalls) {
    assert.equal(call.brightDataKey, '', 'OWE should drop BD key');
  }
});

test('runSERPBackup keeps BD key for null-category shows (safety net)', async () => {
  capturedCalls.length = 0;
  const show = { id: 'mystery-show-2026', category: null };
  await runSERPBackup(show, makeOutlets(3), new Set());

  assert.ok(capturedCalls.length > 0);
  for (const call of capturedCalls) {
    assert.equal(call.brightDataKey, 'test-bd-key',
      'null-category show should STILL use BD — Schmigadoon-style safety net');
  }
});

test('runSERPBackup caps at SERP_BUDGET calls per cycle', async () => {
  capturedCalls.length = 0;
  const show = { id: 'budget-test-2026', category: 'broadway' };
  // Give it way more outlets than the budget
  await runSERPBackup(show, makeOutlets(50), new Set());

  assert.equal(capturedCalls.length, SERP_BUDGET,
    `exactly SERP_BUDGET (${SERP_BUDGET}) calls should have been made, got ${capturedCalls.length}`);
});

test('runSERPBackup uses market as fallback when category absent', async () => {
  capturedCalls.length = 0;
  const show = { id: 'legacy-field-2026', market: 'off-broadway' };
  await runSERPBackup(show, makeOutlets(3), new Set());

  for (const call of capturedCalls) {
    assert.equal(call.brightDataKey, '', 'market=off-broadway should drop BD');
  }
});
