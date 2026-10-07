import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isTimeBudgetExceeded } = require('./collect-time-budget.js');

test('isTimeBudgetExceeded: maxDurationMs=0 (unset) never triggers, regardless of elapsed time', () => {
  assert.equal(isTimeBudgetExceeded({ startTime: 0, now: 1e12, maxDurationMs: 0 }), false);
});

test('isTimeBudgetExceeded: well within budget returns false', () => {
  assert.equal(isTimeBudgetExceeded({ startTime: 1000, now: 1000 + 60_000, maxDurationMs: 540_000 }), false);
});

test('isTimeBudgetExceeded: exactly at the deadline returns true (inclusive)', () => {
  assert.equal(isTimeBudgetExceeded({ startTime: 1000, now: 1000 + 540_000, maxDurationMs: 540_000 }), true);
});

test('isTimeBudgetExceeded: past the deadline returns true', () => {
  assert.equal(isTimeBudgetExceeded({ startTime: 1000, now: 1000 + 600_000, maxDurationMs: 540_000 }), true);
});

test('isTimeBudgetExceeded: one tick before the deadline returns false', () => {
  assert.equal(isTimeBudgetExceeded({ startTime: 1000, now: 1000 + 539_999, maxDurationMs: 540_000 }), false);
});
