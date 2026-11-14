// BRO-2507: unit tests for the pure decision logic behind
// scripts/validate-aggregator-truth.js (→ scripts/lib/aggregator-truth-validator.js).
// The audit moved from test.yml to check-corpus-drift.js (2026-06-21) but is
// still path-listed in test.yml and still gates the drift digest. Fixtures only:
// a data-coupled case would make that advisory check blocking (CLAUDE.md §19).
// CLAUDE.md §15: require() the real functions, never copy logic here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  THRESHOLDS,
  HIGH_COVERAGE_EXCEPTIONS,
  classifyAggregatorTruth,
} = require('../../scripts/lib/aggregator-truth-validator.js');

const ids = (arr) => arr.map(s => s.showId);

test('THRESHOLDS are the documented 1.5 / 0.7 / 2.0 / min-5 bands', () => {
  assert.deepEqual(THRESHOLDS, {
    WARN_DUPLICATE_RATIO: 1.5,
    WARN_MISSING_RATIO: 0.7,
    FAIL_DUPLICATE_RATIO: 2.0,
    MIN_AGGREGATOR_COUNT: 5,
  });
});

test('healthy ratios (0.7..1.5 inclusive) land in healthy only', () => {
  const r = classifyAggregatorTruth({
    a: { maxAggregator: 10, localCount: 10, ratio: 1.0 },
    lo: { maxAggregator: 10, localCount: 7, ratio: 0.7 },
    hi: { maxAggregator: 10, localCount: 15, ratio: 1.5 },
  });
  assert.deepEqual(ids(r.healthy), ['a', 'lo', 'hi']);
  assert.deepEqual(r.definiteDuplicates, []);
  assert.deepEqual(r.likelyDuplicates, []);
  assert.deepEqual(r.likelyMissing, []);
  assert.deepEqual(r.noAggregatorData, []);
});

test('ratio > 2.0 is a definite duplicate (the gate error)', () => {
  const r = classifyAggregatorTruth({ dup: { maxAggregator: 10, localCount: 25, ratio: 2.5 } });
  assert.deepEqual(r.definiteDuplicates, [{ showId: 'dup', localCount: 25, maxAggregator: 10, ratio: 2.5 }]);
});

test('high-coverage exceptions above 2.0 are downgraded to likely duplicates', () => {
  assert.ok(HIGH_COVERAGE_EXCEPTIONS.has('hamilton-2015'));
  const r = classifyAggregatorTruth({ 'hamilton-2015': { maxAggregator: 10, localCount: 25, ratio: 2.5 } });
  assert.deepEqual(r.definiteDuplicates, []);
  assert.deepEqual(r.likelyDuplicates, [
    { showId: 'hamilton-2015', localCount: 25, maxAggregator: 10, ratio: 2.5, isException: true },
  ]);
});

test('1.5 < ratio <= 2.0 is a likely duplicate warning', () => {
  const r = classifyAggregatorTruth({
    b: { maxAggregator: 10, localCount: 16, ratio: 1.6 },
    edge: { maxAggregator: 10, localCount: 20, ratio: 2.0 },
  });
  assert.deepEqual(ids(r.likelyDuplicates), ['b', 'edge']);
  assert.deepEqual(r.definiteDuplicates, []);
});

test('ratio < 0.7 is a likely-missing warning', () => {
  const r = classifyAggregatorTruth({ c: { maxAggregator: 10, localCount: 5, ratio: 0.5 } });
  assert.deepEqual(ids(r.likelyMissing), ['c']);
});

test('null ratio or zero aggregator coverage → noAggregatorData (info, never an error)', () => {
  const r = classifyAggregatorTruth({
    e: { maxAggregator: 0, localCount: 3, ratio: null },
    f: { maxAggregator: 0, localCount: 9, ratio: 9 },
  });
  assert.deepEqual(r.noAggregatorData, [
    { showId: 'e', localCount: 3, maxAggregator: 0 },
    { showId: 'f', localCount: 9, maxAggregator: 0 },
  ]);
  assert.deepEqual(r.definiteDuplicates, []);
});

test('below MIN_AGGREGATOR_COUNT only extreme (>2.0) duplicates are reported', () => {
  const r = classifyAggregatorTruth({
    few: { maxAggregator: 3, localCount: 9, ratio: 3.0 },          // still an error
    fewMissing: { maxAggregator: 3, localCount: 1, ratio: 0.33 },  // dropped silently
    fewHigh: { maxAggregator: 3, localCount: 5, ratio: 1.67 },     // dropped silently
    'hamilton-2015': { maxAggregator: 3, localCount: 9, ratio: 3.0 }, // exception does NOT apply below min
  });
  assert.deepEqual(ids(r.definiteDuplicates), ['few', 'hamilton-2015']);
  assert.deepEqual(r.likelyMissing, []);
  assert.deepEqual(r.likelyDuplicates, []);
  assert.deepEqual(r.healthy, []);
});

test('empty / missing shows map classifies to all-empty buckets', () => {
  for (const input of [{}, undefined]) {
    const r = classifyAggregatorTruth(input);
    for (const bucket of Object.values(r)) assert.deepEqual(bucket, []);
  }
});

test('a missing or NaN ratio is derived from the counts, never "healthy" by default (BRO-5261)', () => {
  const r = classifyAggregatorTruth({
    'no-ratio': { maxAggregator: 12, localCount: 40 },
    'nan-ratio': { maxAggregator: 12, localCount: 40, ratio: NaN },
    'null-entry': null,
  });
  assert.deepEqual(ids(r.definiteDuplicates).sort(), ['nan-ratio', 'no-ratio']);
  assert.deepEqual(ids(r.noAggregatorData), ['null-entry']);
});
