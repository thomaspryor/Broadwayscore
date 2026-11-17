// BRO-7716: fetch-probe bot wall falls back to the in-browser probe.
// Run: node --test scripts/lib/cookie-renew-probe-mode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { resolveProbeMode, planRenewal } = createRequire(import.meta.url)('./cookie-renew.js');

test('fetch bot wall (error) falls back to in-browser probe, plan proceeds', () => {
  const m = resolveProbeMode({ browserOnly: false, probeStatus: 'error' });
  assert.deepEqual(m, { inBrowser: true, probeStatus: 'unknown', fellBack: true });
  assert.equal(planRenewal({ probeStatus: m.probeStatus, cookies: [], authCookies: ['NYT-S'], nowMs: Date.now() }).action, 'refresh');
});
test('vacuous stays a stop, no fallback', () => {
  const m = resolveProbeMode({ browserOnly: false, probeStatus: 'vacuous' });
  assert.equal(m.inBrowser, false);
  assert.equal(planRenewal({ probeStatus: m.probeStatus, cookies: [], authCookies: [], nowMs: 0 }).action, 'stop');
});
test('logged-in / logged-out keep the fetch path', () => {
  for (const s of ['logged-in', 'logged-out']) assert.deepEqual(resolveProbeMode({ browserOnly: false, probeStatus: s }), { inBrowser: false, probeStatus: s, fellBack: false });
});
test('browserOnly is always in-browser, not a fallback', () => {
  assert.deepEqual(resolveProbeMode({ browserOnly: true, probeStatus: 'unknown' }), { inBrowser: true, probeStatus: 'unknown', fellBack: false });
});
