/**
 * Tests for scripts/lib/brand-mention-serp.js — verify it now uses BD-first
 * (preferSpeed=false) after the 2026-05-17 cost-cut flip.
 *
 * Brand-mention runs as a daily background sweep with no user waiting on it.
 * Pre-flip: preferSpeed=true (SB-first) consumed ~60k SB credits/month, ~6%
 * of the post-2026-06-05 1M Startup cap. Post-flip: BD-first saves that cap
 * headroom at the cost of ~$3.60/mo extra BD spend.
 *
 * Stubs serpQuery via require.cache and asserts the preferSpeed option value
 * passed through. Doesn't hit the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const urlDiscoveryPath = require.resolve('../../scripts/lib/url-discovery.js');
let _capturedOptions = null;
require.cache[urlDiscoveryPath] = {
  id: urlDiscoveryPath,
  filename: urlDiscoveryPath,
  loaded: true,
  exports: {
    serpQuery: async (_query, options) => {
      _capturedOptions = options;
      return [];
    },
  },
};

const { fetchXMentions } = await import('../../scripts/lib/brand-mention-serp.js');

test('brand-mention SERP calls use preferSpeed=false (BD-first)', async () => {
  _capturedOptions = null;
  await fetchXMentions(['broadwayscorecard']);
  assert.ok(_capturedOptions, 'serpQuery should have been called');
  assert.equal(
    _capturedOptions.preferSpeed,
    false,
    'brand-mention SERP must be BD-first to preserve post-June-5 SB cap headroom'
  );
});

test('brand-mention SERP forwards nbResults default', async () => {
  _capturedOptions = null;
  await fetchXMentions(['broadwayscorecard']);
  assert.equal(_capturedOptions.nbResults, 20);
});
