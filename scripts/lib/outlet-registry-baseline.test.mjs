import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { baselineKeySet, computeNewViolators } = require('./outlet-registry-baseline.js');

test('baselineKeySet builds a Set from an outletId array', () => {
  const set = baselineKeySet(['camden-new-journal', 'show-score']);
  assert.equal(set.size, 2);
  assert.ok(set.has('camden-new-journal'));
  assert.ok(set.has('show-score'));
});

test('baselineKeySet tolerates a missing/empty array', () => {
  assert.equal(baselineKeySet(undefined).size, 0);
  assert.equal(baselineKeySet([]).size, 0);
});

test('computeNewViolators: stays silent when all missing outlets are baselined', () => {
  const missing = [{ outletId: 'camden-new-journal', count: 20 }];
  const baseline = baselineKeySet(['camden-new-journal']);
  assert.deepEqual(computeNewViolators(missing, baseline), []);
});

test('computeNewViolators: flags an outletId not in the baseline', () => {
  const missing = [
    { outletId: 'camden-new-journal', count: 20 },
    { outletId: 'brand-new-outlet', count: 3 },
  ];
  const baseline = baselineKeySet(['camden-new-journal']);
  const result = computeNewViolators(missing, baseline);
  assert.equal(result.length, 1);
  assert.equal(result[0].outletId, 'brand-new-outlet');
});

test('computeNewViolators: empty baseline flags every missing outlet', () => {
  const missing = [{ outletId: 'a', count: 1 }, { outletId: 'b', count: 1 }];
  const result = computeNewViolators(missing, baselineKeySet([]));
  assert.equal(result.length, 2);
});

test('computeNewViolators: tolerates an empty missingOutlets array', () => {
  assert.deepEqual(computeNewViolators([], baselineKeySet(['x'])), []);
  assert.deepEqual(computeNewViolators(undefined, baselineKeySet(['x'])), []);
});
