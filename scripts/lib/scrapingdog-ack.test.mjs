import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SCRAPINGDOG_ACKNOWLEDGED_BURN, isScrapingdogBurnAcknowledged, evaluateScrapingdogCredits } = require('./scrapingdog-ack.js');

// The real account shape from api.scrapingdog.com/account that fired the
// daily alert (task #418): 923k left of 1M, ~77k/day burn, renews in 29d →
// projected exhaustion ~12d, BEFORE renewal.
const LIVE_ALERT_ACCT = { requestLimit: 1000000, requestUsed: 77000, validity: 29 };

test('projected exhaustion while acknowledged → warn, message carries ack reason', () => {
  const r = evaluateScrapingdogCredits(LIVE_ALERT_ACCT, '2026-07-26');
  assert.equal(r.status, 'warn');
  assert.match(r.message, /BEFORE renewal/);
  assert.match(r.message, /acknowledged: .*ScrapingBee-exhaustion fallthrough/);
  assert.match(r.message, /expires 2026-08-06/);
});

test('projected exhaustion after ack expiry → error again (forced re-triage)', () => {
  const r = evaluateScrapingdogCredits(LIVE_ALERT_ACCT, '2026-08-06');
  assert.equal(r.status, 'error');
  assert.doesNotMatch(r.message, /acknowledged/);
});

test('actually exhausted balance stays error even while acknowledged', () => {
  const r = evaluateScrapingdogCredits({ requestLimit: 1000000, requestUsed: 1000000, validity: 10 }, '2026-07-26');
  assert.equal(r.status, 'error');
  assert.match(r.message, /EXHAUSTED/);
});

test('healthy account → pass', () => {
  const r = evaluateScrapingdogCredits({ requestLimit: 1000000, requestUsed: 100000, validity: 25 }, '2026-07-26');
  assert.equal(r.status, 'pass');
});

test('no validity field falls back to pct thresholds (ack does not apply)', () => {
  assert.equal(evaluateScrapingdogCredits({ requestLimit: 1000000, requestUsed: 960000 }, '2026-07-26').status, 'error');
  assert.equal(evaluateScrapingdogCredits({ requestLimit: 1000000, requestUsed: 900000 }, '2026-07-26').status, 'warn');
});

test('acknowledged before the expiry date', () => {
  assert.equal(isScrapingdogBurnAcknowledged('2026-07-26'), true);
  assert.equal(isScrapingdogBurnAcknowledged('2026-08-05'), true);
});

test('NOT acknowledged on or after the expiry date (forces re-triage)', () => {
  assert.equal(isScrapingdogBurnAcknowledged('2026-08-06'), false);
  assert.equal(isScrapingdogBurnAcknowledged('2026-09-01'), false);
});

test('expiry is the day after the ScrapingBee reset it depends on', () => {
  // scrapingbee-ack expires 2026-08-05 (SB billing reset). This ack must
  // outlive it by exactly one day so the post-reset burn rate is re-triaged
  // with SB traffic restored, not silently masked further.
  const { SCRAPINGBEE_ACKNOWLEDGED_EXHAUSTION } = require('./scrapingbee-ack.js');
  const sb = new Date(SCRAPINGBEE_ACKNOWLEDGED_EXHAUSTION.expires + 'T00:00:00Z');
  const sd = new Date(SCRAPINGDOG_ACKNOWLEDGED_BURN.expires + 'T00:00:00Z');
  assert.equal(sd.getTime() - sb.getTime(), 24 * 60 * 60 * 1000);
});

test('default-today path returns a boolean and matches the explicit-date result', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(isScrapingdogBurnAcknowledged(), isScrapingdogBurnAcknowledged(today));
});
