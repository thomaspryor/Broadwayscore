import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseTimeBudgetMin, createRunBudget } = require('./run-budget.js');

test('parseTimeBudgetMin reads the flag', () => {
  assert.equal(parseTimeBudgetMin(['--time-budget-min=100']), 100);
  assert.equal(parseTimeBudgetMin(['--phase=0,1', '--time-budget-min=25', '--dry-run']), 25);
  assert.equal(parseTimeBudgetMin(['--time-budget-min=2.5']), 2.5);
});

test('parseTimeBudgetMin returns 0 for absent/malformed/non-positive values', () => {
  assert.equal(parseTimeBudgetMin([]), 0);
  assert.equal(parseTimeBudgetMin(['--limit=5']), 0);
  assert.equal(parseTimeBudgetMin(['--time-budget-min=']), 0);
  assert.equal(parseTimeBudgetMin(['--time-budget-min=abc']), 0);
  assert.equal(parseTimeBudgetMin(['--time-budget-min=0']), 0);
  assert.equal(parseTimeBudgetMin(['--time-budget-min=-5']), 0);
  assert.equal(parseTimeBudgetMin(null), 0);
});

test('createRunBudget tracks elapsed time against the budget', () => {
  let t = 1_000_000;
  const clock = () => t;
  const budget = createRunBudget(10, clock); // 10 minutes

  assert.equal(budget.enabled, true);
  assert.equal(budget.exceeded(), false);
  assert.equal(budget.remainingMs(), 600_000);

  t += 9 * 60_000; // 9 min elapsed
  assert.equal(budget.exceeded(), false);
  assert.equal(budget.remainingMs(), 60_000);
  assert.equal(budget.elapsedMin(), 9);

  t += 60_000; // exactly 10 min
  assert.equal(budget.exceeded(), true);
  assert.equal(budget.remainingMs(), 0);

  t += 60_000; // past budget
  assert.equal(budget.exceeded(), true);
  assert.equal(budget.remainingMs(), 0);
});

test('createRunBudget with 0/negative/NaN minutes is disabled', () => {
  for (const minutes of [0, -1, NaN, undefined]) {
    let t = 0;
    const budget = createRunBudget(minutes, () => t);
    assert.equal(budget.enabled, false, `minutes=${minutes}`);
    t += 100 * 60_000;
    assert.equal(budget.exceeded(), false, `minutes=${minutes}`);
    assert.equal(budget.remainingMs(), Infinity, `minutes=${minutes}`);
  }
});

test('canStartItem refuses an item that cannot finish inside the budget (BRO-3340)', () => {
  let t = 0;
  const budget = createRunBudget(10, () => t);
  assert.equal(budget.canStartItem(150_000), true); // 10 min left
  t += 7 * 60_000; // 3 min left
  assert.equal(budget.canStartItem(150_000), true);
  t += 31_000; // 2m29s left: a 2.5 min item would overrun
  assert.equal(budget.exceeded(), false, 'exceeded() alone would still start it');
  assert.equal(budget.canStartItem(150_000), false);
  assert.equal(budget.canStartItem(), true, 'no reserve = same as !exceeded()');
  t += 3 * 60_000; // past budget
  assert.equal(budget.canStartItem(), false);
  assert.equal(budget.canStartItem(0), false);
});

test('canStartItem never stops a disabled budget, and ignores a bad reserve', () => {
  let t = 0;
  const off = createRunBudget(0, () => t);
  t += 100 * 60_000;
  assert.equal(off.canStartItem(150_000), true);
  const on = createRunBudget(1, () => t);
  for (const bad of [NaN, -5, undefined]) assert.equal(on.canStartItem(bad), true, String(bad));
  // BRO-5261: an impossible (Infinity) reserve must not read as "no reserve".
  assert.equal(on.canStartItem(Infinity), false);
  assert.equal(off.canStartItem(Infinity), true, 'a disabled budget still never stops');
});
