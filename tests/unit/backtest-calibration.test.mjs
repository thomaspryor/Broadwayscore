import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { calibrationFailures } = require('../../scripts/lib/backtest-calibration.js');
const group = (n, newMae, newInside) => ({ n, newMae, newInside });

test('calibration tolerates corpus drift beyond every former absolute bound', () => {
  for (const [live, disabled] of [
    [group(88, 18, 30), group(88, 23, 28)],
    [group(40, 20, 12), group(40, 25, 12)],
    [group(91, 8, 60), group(91, 9, 59)],
    [group(45, 9, 20), group(45, 11, 19)],
  ]) assert.deepEqual(calibrationFailures(live, disabled), []);
});

test('lost calibration and worse inside coverage still fail', () => {
  assert.match(calibrationFailures(group(88, 23, 30), group(88, 23, 30)).join(), /lost its MAE gain/);
  assert.match(calibrationFailures(group(88, 24, 30), group(88, 23, 30)).join(), /lost its MAE gain/);
  assert.match(calibrationFailures(group(88, 18, 29), group(88, 23, 30)).join(), /reduced inside count/);
});

test('empty, non-finite or mismatched cohorts cannot pass as drift', () => {
  for (const invalid of [undefined, group(0, 0, 0), group(88, NaN, 30), group(88, Infinity, 30), group(88, -1, 30), group(88, 18, 89)]) {
    assert.match(calibrationFailures(invalid, group(88, 23, 30)).join(), /invalid/);
    assert.match(calibrationFailures(group(88, 18, 30), invalid).join(), /invalid/);
  }
  assert.match(calibrationFailures(group(87, 18, 30), group(88, 23, 30)).join(), /cohort changed/);
});

test('real timing and reported-truth tests use the paired comparison without absolute bounds', () => {
  const source = readFileSync(new URL('../../scripts/lib/musical-model-backtest.test.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("require('./backtest-calibration.js')"), 'backtest must import the real comparison');
  assert.ok(source.includes('calibrationFailures(live, disabled)'), 'backtest must call the paired comparison');
  assert.ok(source.includes("checkCalibration('--timing')"), 'timing must use the paired comparison');
  assert.ok(source.includes("checkCalibration('--base=HEAD')"), 'reported truth must use the paired comparison');
  assert.ok(!/assert\.ok\([^\n]*(?:newMae|newInside|\.n)\s*(?:<=|>=)\s*\d/.test(source), 'absolute data bounds must not gate the backtest');
  assert.ok(!/allOff\.newMae\s*-\s*m\.newMae\s*>=\s*\d/.test(source), 'a fixed gain floor must not gate the backtest');
});
