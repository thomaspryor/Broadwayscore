/**
 * BRO-114: checkReverseDiscoveryFreshness() (scripts/lib/reverse-discovery-
 * freshness.js) is the pure decision function that flags a stale
 * reverse-discovery-candidates.json before a delayed/skipped cron run lets a
 * BWW roundup rotate out of its ~5-day window unseen. reverseDiscoveryFreshnessResults()
 * (scripts/health-check.js) formats it into a digest row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { checkReverseDiscoveryFreshness, STALE_WARN_HOURS, STALE_ERROR_HOURS } = require('../../scripts/lib/reverse-discovery-freshness.js');
const { reverseDiscoveryFreshnessResults } = require('../../scripts/health-check.js');

const NOW = new Date('2026-08-26T12:00:00.000Z').getTime();

test('checkReverseDiscoveryFreshness: null/undefined/missing generatedAt returns null', () => {
  assert.equal(checkReverseDiscoveryFreshness(null, NOW), null);
  assert.equal(checkReverseDiscoveryFreshness(undefined, NOW), null);
  assert.equal(checkReverseDiscoveryFreshness({}, NOW), null);
  assert.equal(checkReverseDiscoveryFreshness({ generatedAt: 'not-a-date' }, NOW), null);
});

test('checkReverseDiscoveryFreshness: fresh (within one 6h cron cycle) returns null', () => {
  const report = { generatedAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString() };
  assert.equal(checkReverseDiscoveryFreshness(report, NOW), null);
});

test('checkReverseDiscoveryFreshness: just under warn threshold returns null', () => {
  const report = { generatedAt: new Date(NOW - (STALE_WARN_HOURS - 0.1) * 60 * 60 * 1000).toISOString() };
  assert.equal(checkReverseDiscoveryFreshness(report, NOW), null);
});

test('checkReverseDiscoveryFreshness: past warn threshold but under error threshold is warn', () => {
  const report = { generatedAt: new Date(NOW - (STALE_WARN_HOURS + 1) * 60 * 60 * 1000).toISOString() };
  const result = checkReverseDiscoveryFreshness(report, NOW);
  assert.ok(result);
  assert.equal(result.severity, 'warn');
  assert.ok(result.hoursStale >= STALE_WARN_HOURS);
});

test('checkReverseDiscoveryFreshness: past error threshold is error', () => {
  const report = { generatedAt: new Date(NOW - (STALE_ERROR_HOURS + 1) * 60 * 60 * 1000).toISOString() };
  const result = checkReverseDiscoveryFreshness(report, NOW);
  assert.ok(result);
  assert.equal(result.severity, 'error');
});

test('STALE_WARN_HOURS and STALE_ERROR_HOURS match documented thresholds', () => {
  assert.equal(STALE_WARN_HOURS, 24);
  assert.equal(STALE_ERROR_HOURS, 96);
});

// --- reverseDiscoveryFreshnessResults (health-check.js digest formatting) ---

test('reverseDiscoveryFreshnessResults: fresh report yields nothing', () => {
  const report = { generatedAt: new Date(NOW - 1 * 60 * 60 * 1000).toISOString() };
  assert.deepEqual(reverseDiscoveryFreshnessResults(report, NOW), []);
});

test('reverseDiscoveryFreshnessResults: stale-but-empty candidates still warns (the dangerous silent case)', () => {
  const report = { generatedAt: new Date(NOW - 48 * 60 * 60 * 1000).toISOString(), candidates: [] };
  const results = reverseDiscoveryFreshnessResults(report, NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /48\.0h old/);
  assert.match(results[0].hint, /docs\/bww-reverse-discovery-backfill-visibility\.md/);
});

test('reverseDiscoveryFreshnessResults: very stale report is error severity', () => {
  const report = { generatedAt: new Date(NOW - 100 * 60 * 60 * 1000).toISOString() };
  const results = reverseDiscoveryFreshnessResults(report, NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'error');
});

test('reverseDiscoveryFreshnessResults: absent report yields nothing', () => {
  assert.deepEqual(reverseDiscoveryFreshnessResults(null, NOW), []);
  assert.deepEqual(reverseDiscoveryFreshnessResults(undefined, NOW), []);
});
