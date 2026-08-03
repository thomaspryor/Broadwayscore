/**
 * Tests for censusRecallTrendResults (task #898/#901).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { censusRecallTrendResults, NAIVE_DROP_THRESHOLD_PP } = require('./census-recall-trend.js');

function run(naiveRecall, combinedRecall = 0.5) {
  return { generatedAt: '2026-08-03T00:00:00Z', totals: { naiveRecall, combinedRecall } };
}

test('empty or single-entry history — nothing to trend yet', () => {
  assert.deepEqual(censusRecallTrendResults([]), []);
  assert.deepEqual(censusRecallTrendResults([run(0.5)]), []);
});

test('stable naive recall — no warning', () => {
  const history = [run(0.54), run(0.55), run(0.53), run(0.54)];
  assert.deepEqual(censusRecallTrendResults(history), []);
});

test('naive recall drops >10pp vs trailing mean — warns', () => {
  const history = [run(0.54), run(0.55), run(0.53), run(0.40)];
  const results = censusRecallTrendResults(history);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /naive recall dropped/);
});

test('drop exactly at the threshold does not warn (strictly greater than)', () => {
  // trailing mean 0.54, current 0.44 -> 10.0pp drop, not > threshold
  const history = [run(0.54), run(0.54), run(0.54), run(0.44)];
  assert.equal(NAIVE_DROP_THRESHOLD_PP, 10);
  assert.deepEqual(censusRecallTrendResults(history), []);
});

test('combined (scoped+onDisk) coverage falling vs prior run warns even if naive is stable', () => {
  const history = [run(0.54, 0.70), run(0.54, 0.72), run(0.54, 0.60)];
  const results = censusRecallTrendResults(history);
  assert.equal(results.length, 1);
  assert.match(results[0].message, /scoped\+onDisk coverage fell/);
});

test('only trends against the trailing 4 runs, not full history', () => {
  // 6 healthy runs at 0.55, then a real regression to 0.30 — trailing mean of
  // the last 4 prior runs is still 0.55, so the regression must still fire.
  const history = [run(0.55), run(0.55), run(0.55), run(0.55), run(0.55), run(0.55), run(0.30)];
  const results = censusRecallTrendResults(history);
  assert.equal(results.length, 1);
});
