// BRO-3581: CI rebuild losses must not silently lower the deploy-watermark baseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { evaluateWatermarkWrite, WATERMARK_ENFORCE_PCT } = require('./corpus-determinism.js');
const { evaluateReviewCountRegression } = require('./regression-guard.js');

const CI = { CI: 'true' };

test('healthy rebuild (no loss / growth) writes normally', () => {
  assert.deepEqual(evaluateWatermarkWrite({ env: CI, existingWatermarkCount: 20000, newCount: 20000 }).write, true);
  const grow = evaluateWatermarkWrite({ env: CI, existingWatermarkCount: 20000, newCount: 20500 });
  assert.equal(grow.write, true);
  assert.equal(grow.advisory, undefined);
});

test('first run (no watermark yet) writes', () => {
  assert.equal(evaluateWatermarkWrite({ env: CI, newCount: 100 }).write, true);
});

test('2-10% loss still writes but is reported advisory (no deploy wedge on routine cleanup)', () => {
  const r = evaluateWatermarkWrite({ env: CI, existingWatermarkCount: 20668, newCount: 20668 - 756 });
  assert.equal(r.write, true);
  assert.match(r.advisory, /baseline lowered/);
});

test('loss under the warn threshold is silent', () => {
  const r = evaluateWatermarkWrite({ env: CI, existingWatermarkCount: 20000, newCount: 19700 });
  assert.equal(r.write, true);
  assert.equal(r.advisory, undefined);
});

test('catastrophic CI loss keeps the last known-good baseline', () => {
  for (const newCount of [17286, 11000, 0]) {
    const r = evaluateWatermarkWrite({ env: CI, existingWatermarkCount: 28811, newCount });
    assert.equal(r.write, false, `newCount ${newCount}`);
    assert.match(r.reason, /force_write/);
  }
});

test('boundary: exactly the enforce threshold still writes, just over does not', () => {
  const at = 20000 * (1 - WATERMARK_ENFORCE_PCT / 100);
  assert.equal(evaluateWatermarkWrite({ env: CI, existingWatermarkCount: 20000, newCount: at }).write, true);
  assert.equal(evaluateWatermarkWrite({ env: CI, existingWatermarkCount: 20000, newCount: at - 1 }).write, false);
});

test('--force-write is the intentional reset and always writes', () => {
  assert.equal(evaluateWatermarkWrite({ env: CI, forceWrite: true, existingWatermarkCount: 20000, newCount: 5000 }).write, true);
});

test('local runs stay blocked regardless (task #653 gate preserved)', () => {
  assert.equal(evaluateWatermarkWrite({ env: {}, existingWatermarkCount: 20000, newCount: 20000 }).write, false);
  assert.equal(evaluateWatermarkWrite({ env: { ALLOW_LOCAL_WATERMARK: '1' }, newCount: 1 }).write, true);
});

test('two-step compounding: run B sees "ok" vs the lowered reviews.json yet the watermark still refuses', () => {
  // run A: 20000 -> 11000 against reviews.json 20000: CI warns and proceeds.
  assert.equal(evaluateReviewCountRegression({ existingCount: 20000, newCount: 11000, forceWrite: false, isCI: true }).action, 'warn');
  // watermark is NOT lowered by run A, so run B (11000 vs reviews.json 11000 = ok) is checked against 20000.
  assert.equal(evaluateReviewCountRegression({ existingCount: 11000, newCount: 11000, forceWrite: false, isCI: true }).action, 'ok');
  assert.equal(evaluateWatermarkWrite({ env: CI, existingWatermarkCount: 20000, newCount: 11000 }).write, false);
});

test('both writers are wired through evaluateWatermarkWrite', () => {
  for (const f of ['../rebuild-all-reviews.js', '../pre-deploy-check.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /evaluateWatermarkWrite\(/, f);
    assert.doesNotMatch(src, /\.shouldWriteDeployWatermark\(process\.env\)|= shouldWriteDeployWatermark\(/, f);
  }
});
