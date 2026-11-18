// BRO-7716: fetch-probe bot wall falls back to the in-browser probe.
// Run: node --test scripts/lib/cookie-renew-probe-mode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { resolveProbeMode, planRenewal, decideControlUnverified, decideControlBlocked, trackUncertain } = createRequire(import.meta.url)('./cookie-renew.js');

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
test('unreadable anonymous control: tolerated only for fallback + probe-only, else fail closed', () => {
  assert.equal(decideControlUnverified({ fellBack: true, probeOnly: true }), 'probe-only-ok');
  assert.equal(decideControlUnverified({ fellBack: true, probeOnly: false }), 'fail');
  assert.equal(decideControlUnverified({ fellBack: false, probeOnly: true }), 'fail');
  assert.equal(decideControlUnverified({ fellBack: false, probeOnly: false }), 'fail');
});

// BRO-7765: NYT's cookie-less control gets a DataDome 403 every run.
const req = createRequire(import.meta.url);
const { classifyWithControl } = req('./cookie-browser-probe.js');
const { COOKIE_PROBES } = req('./cookie-probes.js');
const DD = { html: '<html><title>nytimes.com</title><script src="https://geo.captcha-delivery.com/x.js"></script></html>', body: '', httpStatus: 403 };
const OK = { html: '<html>article</html>', body: 'x'.repeat(6000), httpStatus: 200 };

test('bot-challenged control is named control-blocked, not a generic error', async () => {
  const r = await classifyWithControl(COOKIE_PROBES.nytimes, OK, { anon: async () => DD });
  assert.equal(r.status, 'control-blocked');
});
test('control-blocked is walled only for probes that declare it (nytimes yes, others fail closed)', () => {
  assert.equal(COOKIE_PROBES.nytimes.controlBlockedIsWalled, true);
  assert.equal(decideControlBlocked(COOKIE_PROBES.nytimes), 'walled');
  assert.equal(decideControlBlocked(COOKIE_PROBES.wapo), 'unverified');
});
test('a challenge on the in-profile page is still an error, not control-blocked', async () => {
  const r = await classifyWithControl(COOKIE_PROBES.nytimes, DD, { anon: async () => DD });
  assert.equal(r.status, 'error');
});
test('repeating uncertain probe alerts after 12h (two 6h runs), once', () => {
  const t0 = Date.parse('2026-11-18T00:00:00Z');
  let r = trackUncertain({}, 1, t0);
  assert.equal(r.alert, false);
  r = trackUncertain(r.state, 1, t0 + 6 * 3600e3);
  assert.equal(r.alert, false);
  r = trackUncertain(r.state, 1, t0 + 12 * 3600e3);
  assert.equal(r.alert, true);
  assert.equal(trackUncertain(r.state, 1, t0 + 18 * 3600e3).alert, false);
});
