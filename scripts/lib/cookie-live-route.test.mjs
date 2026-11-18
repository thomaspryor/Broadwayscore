// BRO-7757 class guard: "<outlet> login cookies fail the live access check: reviews will score on
// paywall-truncated text" was filed for nytimes, wapo and ft (BRO-7717/7718/7719) while their
// cookies were healthy, because the default Layer-3 route (ScrapingBee) cannot carry a subscriber
// session. A hard-paywall outlet (auth cookies) must use a route that authenticates, or declare
// ciLiveUnverifiable so a CI-only blind spot never files a card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CRITICAL_OUTLETS } = require('../check-cookie-health.js');
const { findCookieFailures, buildAlert } = require('./cookie-expiry-alert.js');

const AUTHENTICATING_ROUTES = (c) => c.liveRoute === 'cookie-plain' || c.proxyBlocked === true || !!c.ciLiveUnverifiable;

test('no hard-paywall outlet uses the default ScrapingBee live route', () => {
  const bad = Object.entries(CRITICAL_OUTLETS)
    .filter(([, c]) => !c.noCookiesRequired && (c.authCookies || []).length > 0 && !AUTHENTICATING_ROUTES(c))
    .map(([k]) => k);
  assert.deepEqual(bad, [], `outlets with auth cookies on the ScrapingBee route (it serves the logged-out page): ${bad}`);
});

test('nytimes, wapo, ft are declared CI-unverifiable (regression: BRO-7717/7718/7719)', () => {
  for (const k of ['nytimes', 'wapo', 'ft']) assert.ok(CRITICAL_OUTLETS[k].ciLiveUnverifiable, k);
});

test('a ciLiveUnverifiable outlet produces a warn, so no card is filed', () => {
  // mirrors check-cookie-health.js main(): the layer-3 result for such an outlet
  const r = { name: 'ft', layer: 3, status: 'warn', isCritical: true, message: 'Live check unverified' };
  assert.deepEqual(findCookieFailures([r], 7), []);
});

test('a real live failure still files a card', () => {
  const r = { name: 'thestage', layer: 3, status: 'fail', isCritical: true, message: 'x' };
  assert.equal(findCookieFailures([r], 7).length, 1);
  assert.match(buildAlert(r).title, /live access check/);
});

test('an unverifiable live result resolves a stale live-access card instead of leaving it open', () => {
  const { findCookieHealthy } = require('./cookie-expiry-alert.js');
  const r = { name: 'ft', layer: 3, status: 'warn', isCritical: true, unverifiable: true };
  assert.deepEqual(findCookieHealthy([r], 7), [{ name: 'ft', live: true }]);
});
