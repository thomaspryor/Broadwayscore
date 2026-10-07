// Task #653 — corpus determinism metrics + the deploy-watermark write gate.
//
// Fixtures below are the REAL watermark series taken from git history of
// data/audit/deploy-watermark.json, so the detector is asserted against the
// incident it exists to catch rather than a synthetic shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeTransitions,
  findTransientExcursions,
  buildReport,
  evaluateGate,
  shouldWriteDeployWatermark,
} = require('../../scripts/lib/corpus-determinism.js');

const s = (t, rc, subj = '') => ({ t, rc, subj, sha: `sha${t}` });

// 2026-08-02 09:40 → 10:10 UTC, verbatim: baseline → review-refresh spike → baseline.
const AUG2 = [
  s(1000, 19349, 'data: Rebuild reviews.json - collect-review-texts'),
  s(2000, 19361, 'data: Fast rebuild - Supplemental'),
  s(3000, 19510, 'data: Refresh review data for 157 shows'),
  s(4000, 19358, 'data: Rebuild reviews.json - collect-review-texts'),
  s(5000, 19364, 'data: Rebuild reviews.json - after LLM scoring'),
];

// A day with normal churn: monotone-ish growth plus ±1 dedup noise.
const CALM = [s(1000, 19300), s(2000, 19301), s(3000, 19300), s(4000, 19304), s(5000, 19305)];

test('computeTransitions drops no-op samples and keeps signed deltas', () => {
  const tr = computeTransitions([s(1, 100), s(2, 100), s(3, 90), s(4, 130)]);
  assert.deepEqual(tr.map(x => x.delta), [-10, 40]);
});

test('detects the 2026-08-02 review-refresh excursion', () => {
  const found = findTransientExcursions(AUG2);
  assert.equal(found.length, 1);
  assert.equal(found[0].before, 19361);
  assert.equal(found[0].spike, 19510);
  assert.equal(found[0].after, 19358);
  assert.equal(found[0].exact, false, '19361 → 19358 is within tolerance but not an exact revert');
  assert.match(found[0].subj, /Refresh review data/);
});

test('exact reverts are flagged as such', () => {
  const found = findTransientExcursions([s(1, 19334), s(2, 19470), s(3, 19334)]);
  assert.equal(found.length, 1);
  assert.equal(found[0].exact, true);
});

test('ordinary ±1 churn is not an excursion and is not a material decrease', () => {
  assert.equal(findTransientExcursions(CALM).length, 0);
  const report = buildReport(CALM);
  assert.equal(report.decreases, 1, 'the -1 dedup step is still counted as a raw decrease');
  assert.equal(report.materialDecreases, 0, 'but it must not count toward the flap gate');
});

test('a real corpus drop that STAYS is not an excursion', () => {
  // A genuine cleanup moves the baseline; the neighbours do not match afterwards.
  const found = findTransientExcursions([s(1, 19500), s(2, 19300), s(3, 19305)]);
  assert.equal(found.length, 0);
});

test('gate fails on excursions and passes on a calm window', () => {
  assert.equal(evaluateGate(buildReport(AUG2)).pass, false);
  assert.match(evaluateGate(buildReport(AUG2)).failures.join(' '), /transient excursion/);
  assert.equal(evaluateGate(buildReport(CALM)).pass, true);
});

test('gate fails when material decreases exceed the limit', () => {
  const samples = [s(0, 20000)];
  for (let i = 1; i <= 12; i++) samples.push(s(i * 100, 20000 + (i % 2 === 0 ? 60 * i : 60 * i - 200)));
  const report = buildReport(samples);
  const gate = evaluateGate(report, { maxMaterialDecreases: 2, maxExcursions: 99 });
  assert.equal(gate.pass, false);
  assert.match(gate.failures.join(' '), /decreases >= 40/);
});

test('deploy watermark is written only from CI (or an explicit local override)', () => {
  assert.equal(shouldWriteDeployWatermark({ CI: 'true' }).write, true);
  assert.equal(shouldWriteDeployWatermark({}).write, false);
  assert.equal(shouldWriteDeployWatermark({ ALLOW_LOCAL_WATERMARK: '1' }).write, true);
  assert.match(shouldWriteDeployWatermark({}).reason, /local run/);
});
