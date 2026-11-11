/**
 * BRO-7347: leakage guard for the earlier-run review input. require()s the real module.
 * Run: node --test tests/unit/review-forecast-v2-earlier-run-leakage.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RF = require('../../scripts/lib/review-forecast.js');
const ER = require('../../scripts/lib/review-forecast-v2-earlier-run.js');

const target = { id: 'T', openingDate: '2015-03-12' };
const build = (reviews, cut) => ER.buildEarlierRunFeatures(target, { earlierRun: { T: reviews } }, 70, cut ? { cut } : {});

test('partial dates are read as the last day of the period', () => {
  assert.equal(ER.latestDay('2013'), '2013-12-31');
  assert.equal(ER.latestDay('2010-04'), '2010-04-30');
  assert.equal(ER.latestDay('2012-02'), '2012-02-29');
  assert.equal(ER.latestDay('2010-04-06'), '2010-04-06');
  assert.equal(ER.latestDay('garbage'), null);
});

test('reviews dated after opening minus the lag never feed the target', () => {
  const ok = build([[90, '2015-03-01', 0]]);
  assert.equal(ok.has.earlierRun, true);
  ER.assertNoLeakageEarlierRun(target, ok.provenance);
  for (const d of ['2015-03-12', '2015-03-10', '2015-03', '2015', '2016-01-01', 'junk']) {
    const f = build([[90, d, 0]]);
    assert.equal(f.has.earlierRun, false, `${d} must be dropped`);
    assert.deepEqual(f.x, build([]).x);
  }
  assert.equal(build([[90, `2015-03-${String(12 - RF.LAG_DAYS).padStart(2, '0')}`, 0]]).has.earlierRun, true, 'exactly the lag counts');
});

test('corrupting post-cutoff reviews changes nothing', () => {
  const base = build([[80, '2015-01-05', 0], [60, '2015-02-01', 0]]);
  const noisy = build([[80, '2015-01-05', 0], [60, '2015-02-01', 0], [5, '2015-03-20', 0], [99, '2015', 0]]);
  assert.deepEqual(noisy.x, base.x);
});

test('step form: below the cut is low, at or above is high; linear is the shrunk gap to the baseline', () => {
  assert.equal(build([[70, '2015-01-01', 0]]).x.erLow, 1);
  assert.equal(build([[75, '2015-01-01', 0]]).x.erHigh, 1);
  const f = build([[90, '2015-01-01', 0], [90, '2015-01-02', 0]]);
  assert.ok(Math.abs(f.x.erDev - (2 * 90 + ER.ER_SHRINK_K * 70) / (2 + ER.ER_SHRINK_K) + 70) < 1e-9);
});

test('assertNoLeakageEarlierRun rejects late and undated provenance', () => {
  for (const p of [{ date: '2015-03-11' }, { date: null }, { date: '2016-01-01' }]) {
    assert.throws(() => ER.assertNoLeakageEarlierRun(target, [{ kind: 'earlier-run-review', ref: 'T', ...p }]), /LEAKAGE\(earlier-run\)/);
  }
});
