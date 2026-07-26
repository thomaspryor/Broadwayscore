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

test('near-dry balance (<=5% left) stays error even while acknowledged (ship-check P1)', () => {
  // 1% left, projects exhaustion — the ack must NOT swallow this: SD is one
  // day from silently dumping all traffic onto BD.
  const r = evaluateScrapingdogCredits({ requestLimit: 1000000, requestUsed: 995000, validity: 10 }, '2026-07-26');
  assert.equal(r.status, 'error');
  assert.doesNotMatch(r.message, /acknowledged/);
});

test('exhaustion projected within 3 days stays error even while acknowledged (runaway-spike shape)', () => {
  // 20% left but burning so fast it dies in ~2 days — that is not the gradual
  // SB-fallthrough the ack covers.
  const r = evaluateScrapingdogCredits({ requestLimit: 1000000, requestUsed: 800000, validity: 20 }, '2026-07-26');
  assert.equal(r.status, 'error');
  assert.doesNotMatch(r.message, /acknowledged/);
});

test('waiver boundaries: exactly 5% left stays error; exactly 3 days out is still waivable (codex re-review pins)', () => {
  // pctRemaining uses Math.round, so pick numbers that land exactly on the
  // boundary. 5.0% → NOT > 5 → error even while acked.
  const atFivePct = evaluateScrapingdogCredits({ requestLimit: 1000000, requestUsed: 950000, validity: 25 }, '2026-07-26');
  assert.equal(atFivePct.status, 'error');
  // Exactly 3.0 days until exhaustion (>= 3) with healthy pct → still waived.
  // used=600k over daysIntoCycle=20 (validity=10) → 30k/day; remaining 400k... use
  // constructed numbers: limit 1M, used 750k, validity 21 → daysIntoCycle 9,
  // burn 83.33k/day, remaining 250k → exactly 3.0 days; pct 25%.
  const atThreeDays = evaluateScrapingdogCredits({ requestLimit: 1000000, requestUsed: 750000, validity: 21 }, '2026-07-26');
  assert.equal(atThreeDays.status, 'warn');
  assert.match(atThreeDays.message, /acknowledged/);
  // A hair under 3 days flips to error: same shape, slightly more burned.
  const underThreeDays = evaluateScrapingdogCredits({ requestLimit: 1000000, requestUsed: 760000, validity: 21 }, '2026-07-26');
  assert.equal(underThreeDays.status, 'error');
});

test('negative or non-finite validity takes the no-validity pct path (sanitized)', () => {
  // Healthy pct + garbage validity → pass via pct thresholds, no projection.
  for (const v of [-1, NaN, Infinity]) {
    const r = evaluateScrapingdogCredits({ requestLimit: 1000000, requestUsed: 100000, validity: v }, '2026-07-26');
    assert.equal(r.status, 'pass', `validity=${v}`);
    assert.doesNotMatch(r.message, /burn/);
  }
});

test('malformed account response reports warn, not NaN pass (ship-check contract guard)', () => {
  for (const bad of [null, {}, { requestLimit: 'a lot', requestUsed: 5 }, { requestLimit: 0, requestUsed: 0 }, { requestLimit: 1000000 }]) {
    const r = evaluateScrapingdogCredits(bad, '2026-07-26');
    assert.equal(r.status, 'warn', `expected warn for ${JSON.stringify(bad)}`);
    assert.match(r.message, /Unexpected account response/);
  }
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
