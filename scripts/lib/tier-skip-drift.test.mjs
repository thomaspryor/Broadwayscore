// S1-T3 (Scraping cost v3, card 3b1637c5): domain-tier-skip.json drift check
// pure decision functions. See scripts/lib/tier-skip-drift.js header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  evaluateDegradeDrift,
  evaluateRecoveryProbe,
  resolveDegradeConfig,
  DEFAULT_DEGRADE_MIN_CALLS,
  DEFAULT_DEGRADE_THRESHOLD,
} = require('./tier-skip-drift.js');

// --- degrade direction ---

test('degrade: skip:false host failing hard over a real sample alerts', () => {
  const r = evaluateDegradeDrift({ currentSkip: false, successes: 11, failures: 543 }); // ~2% success, mirrors the card's cited DTLI rate
  assert.equal(r.alert, true);
  assert.match(r.reason, /flipping to skip:true/);
  assert.equal(r.totalCalls, 554);
});

test('degrade: skip:false host with healthy success rate does not alert', () => {
  const r = evaluateDegradeDrift({ currentSkip: false, successes: 470, failures: 30 });
  assert.equal(r.alert, false);
  assert.match(r.reason, /healthy/);
});

test('degrade: skip:true host is exempt regardless of ledger stats (degrade direction does not apply)', () => {
  const r = evaluateDegradeDrift({ currentSkip: true, successes: 0, failures: 500 });
  assert.equal(r.alert, false);
  assert.match(r.reason, /does not apply/);
});

test('degrade: insufficient sample size does not alert even at 0% success', () => {
  const r = evaluateDegradeDrift({ currentSkip: false, successes: 0, failures: 5 });
  assert.equal(r.alert, false);
  assert.match(r.reason, /insufficient sample/);
  assert.equal(r.successRate, null);
});

test('degrade: exactly at the minCalls boundary is evaluated, one below is not', () => {
  const atBoundary = evaluateDegradeDrift({ currentSkip: false, successes: 10, failures: 90, minCalls: 100 });
  assert.notEqual(atBoundary.successRate, null);
  const belowBoundary = evaluateDegradeDrift({ currentSkip: false, successes: 10, failures: 89, minCalls: 100 });
  assert.equal(belowBoundary.successRate, null);
});

test('degrade: custom threshold and minCalls are honored', () => {
  const r = evaluateDegradeDrift({ currentSkip: false, successes: 40, failures: 60, minCalls: 50, threshold: 0.5 });
  assert.equal(r.alert, true); // 40% < 50% custom threshold
});

// --- recovery direction ---

test('recovery: skip:true host with a strong probe alerts', () => {
  const r = evaluateRecoveryProbe({ currentSkip: true, probeSuccesses: 4, probeTotal: 5 });
  assert.equal(r.alert, true);
  assert.match(r.reason, /flipping to skip:false/);
});

test('recovery: skip:true host with a weak probe does not alert', () => {
  const r = evaluateRecoveryProbe({ currentSkip: true, probeSuccesses: 1, probeTotal: 5 });
  assert.equal(r.alert, false);
  assert.match(r.reason, /still failing/);
});

test('recovery: skip:false host is exempt (recovery direction does not apply)', () => {
  const r = evaluateRecoveryProbe({ currentSkip: false, probeSuccesses: 5, probeTotal: 5 });
  assert.equal(r.alert, false);
  assert.match(r.reason, /does not apply/);
});

test('recovery: insufficient probe sample (e.g. URLs unavailable) does not alert', () => {
  const r = evaluateRecoveryProbe({ currentSkip: true, probeSuccesses: 2, probeTotal: 2, minProbeSize: 5 });
  assert.equal(r.alert, false);
  assert.match(r.reason, /insufficient probe sample/);
  assert.equal(r.successRate, null);
});

test('recovery: threshold boundary — exactly at threshold alerts, just below does not', () => {
  const at = evaluateRecoveryProbe({ currentSkip: true, probeSuccesses: 3, probeTotal: 5, threshold: 0.6 });
  assert.equal(at.alert, true); // 60% >= 60%
  const below = evaluateRecoveryProbe({ currentSkip: true, probeSuccesses: 2, probeTotal: 5, threshold: 0.6 });
  assert.equal(below.alert, false); // 40% < 60%
});

// --- config resolution ---

test('resolveDegradeConfig: defaults when env unset', () => {
  const cfg = resolveDegradeConfig({});
  assert.equal(cfg.minCalls, DEFAULT_DEGRADE_MIN_CALLS);
  assert.equal(cfg.threshold, DEFAULT_DEGRADE_THRESHOLD);
});

test('resolveDegradeConfig: honors env overrides', () => {
  const cfg = resolveDegradeConfig({ TIER_SKIP_DRIFT_MIN_CALLS: '50', TIER_SKIP_DRIFT_THRESHOLD_PCT: '40' });
  assert.equal(cfg.minCalls, 50);
  assert.equal(cfg.threshold, 0.4);
});

test('resolveDegradeConfig: garbage env values fall back to defaults, not NaN/0', () => {
  const cfg = resolveDegradeConfig({ TIER_SKIP_DRIFT_MIN_CALLS: 'abc', TIER_SKIP_DRIFT_THRESHOLD_PCT: '-5' });
  assert.equal(cfg.minCalls, DEFAULT_DEGRADE_MIN_CALLS);
  assert.equal(cfg.threshold, DEFAULT_DEGRADE_THRESHOLD);
});
