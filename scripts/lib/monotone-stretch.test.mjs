import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { stretchScore, validateKnots, TAIL_ONLY_KNOTS } = require('./monotone-stretch.js');
const on = { enabled: true };

test('disabled by default is identity', () => {
  delete process.env.ENSEMBLE_TAIL_STRETCH;
  for (let s = 0; s <= 100; s++) assert.equal(stretchScore(s), s);
});

test('env flag enables it', () => {
  process.env.ENSEMBLE_TAIL_STRETCH = '1';
  try { assert.equal(stretchScore(95), 99); } finally { delete process.env.ENSEMBLE_TAIL_STRETCH; }
});

test('tail-only: identity to 88, 95 -> 99, 100 -> 100', () => {
  for (let s = 0; s <= 88; s++) assert.equal(stretchScore(s, on), s);
  assert.equal(stretchScore(95, on), 99);
  assert.equal(stretchScore(100, on), 100);
});

test('monotone non-decreasing and within 0-100 over the whole range', () => {
  let prev = -Infinity;
  for (let s = 0; s <= 100; s += 0.25) {
    const o = stretchScore(s, on);
    assert.ok(o >= 0 && o <= 100, `bounds at ${s}`);
    assert.ok(o >= prev, `monotone at ${s}`);
    assert.ok(o >= Math.floor(s), `never lowers at ${s}`);
    prev = o;
  }
});

test('clamps out-of-range input, passes non-finite through', () => {
  assert.equal(stretchScore(-5, on), 0);
  assert.equal(stretchScore(130, on), 100);
  assert.ok(Number.isNaN(stretchScore(NaN, on)));
});

test('custom knots validated', () => {
  assert.throws(() => validateKnots([[0, 0], [50, 60], [50, 70], [100, 100]]));
  assert.throws(() => validateKnots([[0, 0], [50, 60], [100, 40]]));
  assert.throws(() => validateKnots([[0, 0], [90, 90]]));
  assert.equal(validateKnots(TAIL_ONLY_KNOTS), TAIL_ONLY_KNOTS);
});
