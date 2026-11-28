import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { expectedFireTimes, fireRateVerdict, parseCron } = require('./cron-fire-rate.js');

const to = Date.parse('2026-11-20T00:00:00Z');
const from = to - 14 * 86400000;

test('expectedFireTimes: */15 over 14 days is the 1,344 the audit measured', () => {
  assert.equal(expectedFireTimes(['*/15 * * * *'], from, to).length, 1344);
});
test('expectedFireTimes: weekday, monthly, union and ranged-step expressions', () => {
  assert.equal(expectedFireTimes(['0 9 * * 1'], from, to).length, 2);
  assert.equal(expectedFireTimes(['30 6 * * 1-5', '0 12 1 * *'], from, to).length, 10); // 10 weekdays, no 1st in window
  assert.equal(expectedFireTimes(['*/5 8-10 * * *'], from, to).length, 14 * 3 * 12);
  assert.equal(expectedFireTimes(['0 0-6/2 * * *'], from, to).length, 14 * 4);
  assert.equal(expectedFireTimes(['0 12 * * 7'], from, to).length, 2); // 7 = Sunday
  assert.equal(expectedFireTimes(['0 12 1,15 * 1'], from, to).length, 2 + 1); // dom OR dow when both restricted: Mon 9,16 + 15th
});
test('expectedFireTimes: the same minute from two expressions counts once', () => {
  assert.equal(expectedFireTimes(['0 * * * *', '0 12 * * *'], from, to).length, 14 * 24);
});
test('parseCron rejects what it cannot read instead of guessing', () => {
  assert.throws(() => parseCron('@daily'));
  assert.throws(() => parseCron('0 0 * * MON'));
});
test('fireRateVerdict: 53 of 1,344 is a shortfall; 67% and 66% shortfalls trip at 0.75; 96% does not', () => {
  assert.equal(fireRateVerdict({ workflow: 'a', expected: 1344, actual: 53 }).shortfall, true);
  assert.equal(fireRateVerdict({ workflow: 'a', expected: 100, actual: 67, minRatio: 0.75 }).shortfall, true);
  assert.equal(fireRateVerdict({ workflow: 'a', expected: 100, actual: 96, minRatio: 0.75 }).shortfall, false);
});
test('fireRateVerdict: too few expected fires are never judged; zero expected is no-expected-fires', () => {
  assert.equal(fireRateVerdict({ workflow: 'a', expected: 2, actual: 0 }).shortfall, false);
  assert.equal(fireRateVerdict({ workflow: 'a', expected: 0, actual: 0 }).status, 'no-expected-fires');
});
test('fireRateVerdict: cancelled sweep needs 3+ cancelled and a quarter of runs', () => {
  assert.equal(fireRateVerdict({ workflow: 'a', expected: 98, actual: 94, cancelled: 28 }).cancelAlert, true);
  assert.equal(fireRateVerdict({ workflow: 'a', expected: 56, actual: 56, cancelled: 5 }).cancelAlert, false);
  assert.equal(fireRateVerdict({ workflow: 'a', expected: 2, actual: 2, cancelled: 2 }).cancelAlert, false);
});
