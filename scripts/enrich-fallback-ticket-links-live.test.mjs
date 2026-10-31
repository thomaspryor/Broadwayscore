import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { probeUrl } = require('./enrich-fallback-ticket-links.js');

// Live smoke test: real https redirect (todaytix.com 308s to www) through the
// REAL fetchStatus. Network-dependent, so it runs in test.yml's
// continue-on-error "slow network-dependent" step — NOT the blocking unit
// batch. Skipped rather than failed when offline.
test('probeUrl live: real redirect chain resolves to allowlisted 2xx', async (t) => {
  const ok = await probeUrl('https://todaytix.com/', 15000);
  if (!ok) {
    // Distinguish "offline" from a genuine regression: a direct www hit
    // failing too means no network — skip; www succeeding means the
    // redirect-follow path really broke — fail.
    const direct = await probeUrl('https://www.todaytix.com/', 15000);
    if (!direct) return t.skip('network unavailable');
  }
  assert.equal(ok, true);
});
